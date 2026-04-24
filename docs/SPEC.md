---
version: 1.0.0
---

# Rundown Specification

Rundown is a format for defining executable runbooks using Markdown. It combines human-readable instructions with machine-executable commands and deterministic control flow.

## 1. Document Structure

A Rundown document (`.runbook.md`) is a Markdown file with an optional YAML frontmatter.

| Element | Markdown | Count | Description |
| :--- | :--- | :--- | :--- |
| **Title** | `# Title` | 0..1 | Document title (metadata). |
| **Description** | Text | 0..1 | Optional description after title. |
| **Steps** | `## ID Title` | 1..N | Top-level execution units. |

### 1.1 Hierarchy
*   **H1**: Metadata (Title).
*   **H2**: Step.
*   **H3**: Substep.
*   **H4+**: Invalid.

### 1.2 Frontmatter

Frontmatter fields beyond `name`, `description`, `version`, `author`, `tags`, `inputs`, `outputs`, and `required` are preserved (open schema). This allows forward-compatible extensions and user-defined metadata.

The `required` field declares variable names that must be provided by the caller (via CLI flags, config, environment, or delegation). Each entry must be a valid template variable identifier matching `/^[a-zA-Z_][a-zA-Z0-9_]*$/`. Required variables must not appear in `inputs` — they have no default. Missing required variables produce a hard error during resolution.

The `inputs` field declares variable names to inject at pipeline setup from the context outputs store (see [§7 Context Passing](#7-context-passing-outputs)). Each entry must match the same identifier pattern as `required`. Entries must not also appear in `vars` — injection is gap-filling only; names already defined by `vars` would never receive an injected value. Reserved runtime names (`step`, `index`, `context`, matched case-insensitively) are rejected. Missing inputs at runtime are silently skipped; the declaration expresses intent rather than hard requirement.

The frontmatter `description` field provides a summary for runbook discovery and listing (`rd ls --all`). The `Runbook.description` in the parsed AST is derived from preamble text between the H1 title and first H2 step. These are independent values.

## 2. Steps

Steps are the fundamental units of execution defined by H2 headers.

### 2.1 Identifiers
Steps must be identified sequentially or by name.

| Format | Type | Usage |
| :--- | :--- | :--- |
| `## 1` | Static | Sequential execution. Must start at 1. |
| `## Name` | Named | GOTO target only. Skipped by default flow. |

**Reserved Names**: `NEXT`, `CONTINUE`, `DEFER`, `DELEGATE`, `COMPLETE`, `STOP`, `GOTO`, `RETRY`, `PASS`, `FAIL`, `YES`, `NO`, `ALL`, `ANY`, `BREAK`, `FOR`, `IN`, `TO`, `AT`.

Reserved word matching is case-sensitive. `NEXT` is reserved; `Next` and `NextStep` are valid.

Named identifiers must match `/^[A-Za-z_][A-Za-z0-9_]*$/`.

### 2.2 Content Order
Step content must appear in this strict order:
1.  **OUTPUTS**: Context output declarations (optional). Must appear as a bullet item immediately after the step header.
2.  **FOR Annotation**: Loop definition (optional). Must appear as a bullet item after directives.
3.  **DELEGATE Annotation**: Delegation marker (optional). See [§4.3 DELEGATE](#43-delegate).
4.  **Transitions**: Control flow rules (optional). Must appear as bullet items immediately after DELEGATE / FOR (or after directives if neither is present). Transitions must appear before any prompt text or body content.
5.  **Prompt**: Text instructions.
6.  **Body**: One of: Code Block or Substeps. A step-level runbook list is shorthand for implicit sequential substeps (`.1`, `.2`, ...).

## 3. Step Bodies

A step must contain exactly one type of body content.

Steps are represented as a discriminated union on `kind`: `'base'` (prompt-only), `'command'` (executable code block), `'substeps'` (nested H3 steps), `'for'` (loop with substeps), `'prompted-for'` (unresolved FOR demoted to prompt-only).

### 3.1 Code Blocks
Executes a command or displays a prompt. Max one code block per step.

| Tag | Type | Behavior |
| :--- | :--- | :--- |
| `bash`, `sh`, `shell` | Executable | Runs in shell. Exit 0 = PASS, else FAIL. |
| `bash prompt`, `prompt` | Display | Output only. Not executed. |
| `json`, `yaml`, etc. | Display | Output only. Treated as prompt. |
| *(none)* | Invalid | Bare code fences (no info string) are rejected. |

Code block info string tags are matched case-insensitively. `BASH`, `Bash`, and `bash` are all treated as executable.

*   **Environment**: Inherits parent environment.
*   **CWD**: Project root.
*   **Stdio**: Inherited.

### 3.2 Substeps

Nested steps defined by H3 (`###`) headers.
* **Identifiers**: `### 1` (bare numeric), `### Name` (bare named), `### 1.1` (qualified numeric), or `### Step.Name` (qualified named). Bare forms inherit their parent step from document position — they belong to the H2 step they appear under. Qualified forms explicitly specify their parent.
* **Strict H3 rule**: When a step contains any valid substep, all H3 headers within that step must be valid substep identifiers.
* **Aggregation**: Parent step outcome is derived from substeps via transitions (`ALL`/`ANY`).

### 3.3 Runbook List Shorthand

List of external runbooks to execute.

```markdown
- ./deploy-db.runbook.md
- ./deploy-api.runbook.md
```

At step level, this syntax is canonicalized to implicit sequential substeps (`1`, `2`, ...), one workflow per substep.
When step-level prompt text appears above this shorthand body, it is attached to the first generated implicit substep only.
These two forms are execution-equivalent:

```markdown
## 2. Review the plan
- review-technical-accuracy.runbook.md
- review-structural-integrity.runbook.md
```

```markdown
## 2. Review the plan
### 2.1
- review-technical-accuracy.runbook.md
### 2.2
- review-structural-integrity.runbook.md
```

Runbook list entries may use template variable references (`{{ VarName }}`) instead of literal paths. These are resolved to concrete runbook target strings during the variable resolution phase. Undefined references are preserved as literal text, consistent with general template variable behavior.

A runbook-list entry may carry a nested `- DELEGATE` bullet to mark that entry for delegation; see [§4.3 DELEGATE](#43-delegate).

### 3.4 Runtime Target Identity
Runtime dispatch/completion identity is canonicalized as:

`step + substep + iteration`

Execution path notation such as `1.2.1` (`STEP.INDEX.SUBSTEP`) is display-only. It is neither authoring syntax nor a canonical identifier.

## 4. Control Flow

Control flow is defined by **Transitions** (conditions) and **Actions** (effects).

### 4.1 Transitions
Syntax: `- {RESULT} [{AGGREGATION}]: {ACTION}`

| Component | Values | Description |
| :--- | :--- | :--- |
| **Result** | `PASS` (`YES`), `FAIL` (`NO`) | Outcome of the step's body. |
| **Aggregation** | `ALL`, `ANY` | For substeps. Step-level runbook-list shorthand is canonicalized to substeps. Default: `PASS ALL`, `FAIL ANY`. |

Aggregation modifiers must form complementary pairs: `PASS ALL` with `FAIL ANY` (pessimistic — any failure stops), or `PASS ANY` with `FAIL ALL` (optimistic — only total failure stops). Non-complementary combinations are invalid because they create evaluation gaps (ALL/ALL) or overlaps (ANY/ANY).

Transition keywords (`PASS`, `YES`, `FAIL`, `NO`) are matched as whole words in list items — the keyword must be followed by whitespace and an action. Words that merely start with a keyword (e.g., `NOTE`, `PASSING`) are not treated as transitions.

**Aggregation semantics:** Aggregation always waits for all DEFER'd results before evaluating. `ALL`/`ANY` evaluates over the count of DEFER'd results, not total substeps/iterations. This mirrors `Promise.allSettled` semantics — all results are collected before the outcome is determined.

**Defaults**:
*   If only `PASS` defined: `FAIL` -> `STOP`.
*   If only `FAIL` defined: `PASS` -> `CONTINUE`.
*   If neither is defined: `PASS CONTINUE`, `FAIL STOP`.
*   Substeps under aggregation or with runbook delegation default to `PASS DEFER`, `FAIL DEFER`.

One-sided aggregation modifiers are rejected — both sides must be explicitly authored (e.g., `PASS ALL ... FAIL ANY ...`).

### 4.2 Actions

| Action | Context | Effect |
| :--- | :--- | :--- |
| `CONTINUE` | Step | Proceed to next step. |
| `CONTINUE` | FOR Iteration-Level | Exit loop (result NOT accumulated). |
| `DEFER` | Substep, FOR Iteration-Level | Pass result up one level for aggregation. |
| `STOP [msg]` | Any | Terminate execution immediately (failure). |
| `COMPLETE [msg]` | Any | Terminate execution immediately (success). |
| `GOTO {Target}` | Any | Jump to step/substep (e.g., `1`, `Error`). |
| `RETRY N Act` | Any | Retry N times, then perform Act (both required). |
| `NEXT` | FOR Substep, FOR Iteration-Level | Skip to next iteration (no result accumulation). |
| `BREAK` | FOR Substep, FOR Iteration-Level | Exit loop immediately. |

> **Shorthand:** A standalone `- DEFER` bullet (without PASS/FAIL prefix) expands to `- PASS DEFER` + `- FAIL DEFER`. This is convenient for substeps where both outcomes should propagate to parent aggregation. DEFER is not valid at step level.

> **RETRY syntax:** Both count and fallback action are required (e.g., `RETRY 3 STOP`). Nested RETRY (RETRY as fallback action) is invalid.

GOTO targeting the containing step (self-reference) without an AT qualifier may create an infinite loop. Use RETRY for bounded re-execution.

**GOTO Syntax**:
*   `GOTO 3`: Jump to Step 3.
*   `GOTO 3` (FOR step, no AT): Defaults to the loop's start value (e.g., `1` for `FOR 1 TO 10`, `5` for `FOR 5 TO 1`).
*   `GOTO 3 AT 1`: Jump to Step 3, iteration 1 (if FOR step).
*   `GOTO 3 AT {{Index}}`: Re-enter Step 3 at current iteration.

> **Internal:** The compiler resolves step-to-step advancement using `CONTINUE` actions mapped to concrete next-step state IDs at compile time. `NEXT` is rejected as a GOTO target by the parser.

### 4.3 DELEGATE

`- DELEGATE` is a structural bullet annotation that marks substeps for delegation. When a DELEGATE step is entered, the execution engine auto-issues a delegation token for each marked substep and surfaces them in the `STEP_ENTERED` event's `delegateFrontier` field (an array of `{id, runbook, token}`). Subagents claim each token with `rd claim`, resolve with `rd pass`/`rd fail`, and the final resolution triggers auto-aggregation of the parent step's transition.

**Syntax.** The annotation is bare — `DELEGATE foo` is a syntax error. DELEGATE accepts three equivalent forms:

* **Step-level** — on the H2 step, propagates to all H3 substeps:
    ```markdown
    ## 1. Delegated work
    - DELEGATE
    - PASS ALL CONTINUE
    - FAIL ANY STOP

    ### 1.1 First task
    - child-a.runbook.md
    ```
* **Per-substep** — on individual H3 substeps, applies only to the annotated substeps:
    ```markdown
    ### 1.1 First task
    - DELEGATE
    - child-a.runbook.md
    ```
* **Runbook-list shorthand** — nested under runbook-list entries (no H3 headers):
    ```markdown
    ## 1. Delegated work
    - child-a.runbook.md
      - DELEGATE
    ```

**Ordering.** `- DELEGATE` precedes transitions and prompt content. When a FOR clause is also present, `FOR ... IN ...` precedes `DELEGATE`.

**Target requirement.** A DELEGATE substep must resolve to a runbook reference (either a `.runbook.md` entry or a template reference). A DELEGATE substep with no runbook target is a structural error.

**Aggregation.** The final substep resolution auto-aggregates the parent step's transition. An explicit `rd collect` CLI invocation triggers aggregation (used when a DELEGATE step mixes delegated and non-delegated substeps, or to force aggregation without waiting for the final subagent callback). Repeat invocations surface `already-aggregated`; terminal drain states propagate result to the parent run via `handleParentCompletion`.

**RETRY on DELEGATE.** `RETRY N Act` on a DELEGATE step is uniform: on retry, every delegated substep in the active frame is cancelled and re-issued with a fresh token, regardless of the substep's prior pass/fail result. Stale tokens return `TOKEN_CANCELLED` on `rd claim`. The `STEP_TRANSITIONED { action: 'RETRY', aggregated: true }` event signals the boundary; the subsequent `STEP_ENTERED` carries the new `delegateFrontier`. This matches §4.2 — `RETRY` re-executes the step's work, and for DELEGATE that work is the fan-out.

## 5. Iteration (FOR)

Steps annotated with `FOR` execute their substeps repeatedly.

| Syntax | Description |
| :--- | :--- |
| `FOR var IN 1 TO N` | Named variable, ascending range. |
| `FOR 1 TO N` | Unnamed, ascending range. |
| `FOR var IN N TO 1` | Named variable, descending range. |
| `FOR N TO 1` | Unnamed, descending range. |
| `FOR var IN N` | Named variable, implicit start (1 TO N). |
| `FOR N` | Unnamed, implicit start (1 TO N). |
| `FOR var IN 1 TO {{Max}}` | Template-variable bound (expanded before parse). |
| `FOR var IN {{source}}` | Named variable, data source (all items). |
| `FOR var IN 1 TO N OF {{source}}` | Named variable, windowed data source. |

*   **Direction**: When `start > end`, iteration descends (step −1). When `start <= end`, it ascends (step +1). Single-number shorthand (`FOR N`) always ascends from 1.
*   **Limits**: Open-ended data source iteration is capped at 10,000 iterations. Numeric bounds are capped at 10,000 at parse time.
*   **Source references**: `{{ source }}` in FOR clauses is NOT template-expanded. It is a data source identifier resolved at runtime. Template-variable bounds (`{{ Max }}`) ARE expanded before parsing.
*   **Unresolved bounds**: When a template-variable bound in a FOR clause cannot be resolved (undefined variable), the step is demoted to `kind: 'prompted-for'` — a substeps-only step with no executable `forClause`. The original FOR text is preserved as prompt text. This allows an orchestrating agent to handle unresolved FOR bounds manually.
*   **Named variable required**: Data source FOR clauses require a named variable. Unnamed syntax (`FOR {{source}}`) is invalid.
*   **Data sources**: Provided at runtime as arrays (in-memory) or files (text or JSONL). Resolved against a sources map. See [RUNDOWN.md](./RUNDOWN.md#data-sources) for configuration.
*   **Constraint**: FOR steps MUST have substeps. Step-level runbook-list shorthand qualifies because it is canonicalized to implicit substeps.
*   **Scope**: Loop variable available in substeps as `{{var}}`.
*   **Aggregation**: Transitions on the parent FOR step evaluate the aggregate result of all iterations.
*   **Iteration-level transitions**: Nested `PASS`/`FAIL` transitions under a `FOR` clause are stored on the `forClause.transitions` field and execute per iteration. Allowed actions: `DEFER` (default, loop back with accumulation), `NEXT` (loop back without accumulation), `CONTINUE` (exit loop), `BREAK` (exit loop), `GOTO`, `STOP`, `COMPLETE` (optionally wrapped by `RETRY`).
* **CONTINUE at iteration scope**: At step level, CONTINUE proceeds to the next step. At FOR iteration level, CONTINUE exits the loop — the current iteration result is NOT accumulated (same as NEXT/BREAK), and execution continues with the step after the FOR step.
*   **Nested bullet rule**: Nested bullets under `FOR` must be transition bullets; non-transition nested bullets are invalid and fail parse.
*   **Retry order**: Iteration-level `RETRY` semantics are deterministic: retry first, then execute the exhausted action. RETRY is universal — it fires for ALL substep actions (including `BREAK` and `NEXT`) based on the iteration result, not the substep action. After retries are exhausted, the substep's action takes effect:
    *   `BREAK` → exit loop (non-accumulating, same as NEXT)
    *   `NEXT` → skip to next iteration (or aggregation at end, non-accumulating)
    *   `DEFER`/`CONTINUE` → configured iteration-level transition applies
* **Execution model**: Each iteration executes its substeps. Each substep produces a **result** (pass/fail). Substep **handlers** map results to **actions**. Only two actions are loop control: `NEXT` (advance to next iteration) and `BREAK` (exit loop). All other actions (`CONTINUE`, `GOTO`, `STOP`, `COMPLETE`) are general flow control that exit the loop as a side effect.

**Iteration execution flow:**

```text
Substeps execute → each produces RESULT (pass/fail)
                 → substep HANDLER maps RESULT to ACTION
                 → DEFER'd results accumulate within iteration
                 → after all substeps: iteration RESULT = aggregate of DEFER'd results
                 → iteration-level HANDLER maps iteration RESULT to ACTION:

    DEFER     → record iteration result, advance to next iteration
    NEXT      → advance to next iteration (do NOT record result)
    BREAK     → exit loop (do NOT record result) → step-level HANDLER
    CONTINUE  → exit loop → step-level HANDLER (current iteration result NOT recorded)
    GOTO/STOP/COMPLETE → exit loop, bypass step-level HANDLER entirely
```

**Result recording by action:**

| Action | Loop Control? | Records Iteration Result | Step-Level Handler Fires |
| :--- | :--- | :--- | :--- |
| `DEFER` | No (accumulate + loop back) | Yes | After final iteration |
| `NEXT` | Yes (skip + loop back) | No | After final iteration |
| `BREAK` | Yes (exit) | No | Yes |
| `CONTINUE` | No (flow control) | No | Yes |
| `GOTO` | No (flow control) | No | No (bypassed) |
| `STOP` | No (flow control) | No | No (bypassed) |
| `COMPLETE` | No (flow control) | No | No (bypassed) |

## 6. Templating

Variables use Handlebars syntax: `{{variable}}`.

| Source | Scope | Description |
| :--- | :--- | :--- |
| CLI (`--var`) | Global | Expanded at startup. |
| `{{Step}}`, `{{step}}` | Step | Current execution identifier for this runbook context (e.g., `1`, `1.2`). |
| `{{Index}}`, `{{index}}` | Loop | Current iteration number for this runbook context. |
| `{{context.current.*}}` | Step/Loop | Canonical current runbook context: `step` (e.g., `3`), `substep` (e.g., `1`), `index` (e.g., `3`), `at` (e.g., `3.3.1` — `STEP.INDEX.SUBSTEP` inside a FOR loop, `STEP.SUBSTEP` otherwise). |
| `{{context.parent.*}}` | Nested | Parent runbook structural context and template variables (`vars.*`). |
| `{{context.ancestors.N.*}}` | Nested | Ancestor runbook contexts (`0` is nearest parent). |
| `{{context.vars.NAME}}` | Global | User/config/frontmatter variable namespace. |
| Loop Var | Loop | Current item/index (e.g., `{{batch}}`). |

*   **Undefined**: Preserved as literal text. A warning is emitted to stderr for each undefined variable.
*   **Evaluation**: Global vars expanded once; Step/Loop vars expanded per iteration.
*   **Parent variables**: `{{context.parent.vars.NAME}}` exposes the parent's resolved template variables. Only non-context keys propagate. Available via both chain (`context.parent.parent.vars.*`) and array (`context.ancestors.N.vars.*`) addressing.
*   **Depth limit**: Parent context chain addressing is capped at 32 levels (enforced on the delegation ancestor chain depth). Exceeding this limit produces an error.
*   **Path resolution**: Dotted paths are supported consistently (for example `{{context.parent.index}}`).
*   **Required variables**: The frontmatter `required` field declares variables that must be provided by the caller via CLI flags, config, environment bridge, or delegation inheritance. Required variables must not appear in `inputs:`. Missing required variables produce a hard error (`MISSING_REQUIRED_VARS`) during resolution. Reserved runtime names are also rejected in `required`.
*   **Reserved keys**: Runtime keys `step`, `index`, and `context` are reserved (matching is case-insensitive — any case variant such as `STEP`, `Step`, `INDEX` is also reserved) and cannot be overridden by user variables. The CLI rejects these names in frontmatter `inputs:`, `required`, `--var` flags, `--var-file` contents, and `.rundown/config.yaml` with an error diagnostic. Reserved names in `RD_VAR_*` environment variables are silently skipped with a warning.
*   **Precedence** (highest to lowest):
    1. CLI flags (`--var-file`, `--var`, `--var-json`) — highest priority
    2. `RD_VAR_*` environment variables (prefix stripped)
    3. `.rundown/config.yaml` (auto-discovered from cwd upward)
    4. Frontmatter `inputs:` field
    5. Inherited delegation variables (parent context)
    6. Built-in defaults — see [§6.1 Built-in Variables](#61-built-in-variables).
    7. INPUTS injected from the context outputs store — fill gaps only, never override an existing variable (including built-ins, which are always present). Silently skipped when `ContextId` is unset or the requested key is absent. See [§7 Context Passing](#7-context-passing-outputs).

### 6.1 Built-in Variables

Rundown sets the following built-in variables once per execution (unless marked dynamic per-step). PascalCase is canonical; lowercase aliases `step` and `index` are also accepted.

| Variable | Example Value | Description |
|----------|---------------|-------------|
| `Date` | `2026-02-04` | Current date (YYYY-MM-DD) |
| `DateTime` | `2026-02-04T10:30:00.000Z` | Full ISO 8601 timestamp |
| `Year` | `2026` | Current year |
| `Month` | `02` | Current month (01-12) |
| `Day` | `04` | Current day (01-31) |
| `Branch` | `feature/my-work` | Current git branch name (empty when not in git) |
| `WorkPath` | `.rundown/work/feature-my-work` | Branch-isolated artifact directory (falls back to `.rundown/work` outside git). Default base directory for the `{{ path "..." }}` helper used in OUTPUTS expressions — see [§7.1 OUTPUTS](#71-outputs). |
| `RunId` | `4a7f0c3e` | Unique-per-execution identifier (fresh 8-char hex per execution; each child in a delegation tree gets its own) |
| `ContextId` | `a3b8c1d2` | Shared identity across a delegation tree. Scopes `{{ path "..." }}` helper output into `.rd-<ContextId>/` for context passing — see [§7 Context Passing](#7-context-passing-outputs). Children inherit the parent's `ContextId` via `--var`. Overridable via `--var ContextId=<name>` for a meaningful identifier (e.g., `sprint-42`). |
| `Step` | `3.1` | Current qualified step identifier (dynamic per step) |
| `Index` | `3` | Current loop iteration number inside FOR (dynamic per iteration) |
| `context.current.step` | `3.1` | Canonical current step identifier (dynamic) |
| `context.current.substep` | `1` | Current substep number when in a substep (dynamic) |
| `context.current.index` | `3` | Current loop iteration inside FOR (dynamic) |
| `context.current.at` | `3.3.1` | Full execution position (`STEP.INDEX.SUBSTEP` inside a FOR loop, `STEP.SUBSTEP` otherwise) (dynamic) |

Static variables (`Date`, `DateTime`, `Year`, `Month`, `Day`, `Branch`, `WorkPath`, `RunId`, `ContextId`) can be overridden via `--var`. Dynamic variables (`Step`, `Index`, `context.current.*` and their lowercase aliases) reflect the current execution position and cannot be overridden. The variable name `context` is reserved.

**Plugin Variables:** When a runbook is resolved from a plugin source (e.g., `rundown:write-plan`), Rundown auto-injects additional variables using UPPER_SNAKE_CASE (mirroring host environment conventions):

| Variable | Description |
|----------|-------------|
| `CLAUDE_PLUGIN_ROOT` | Plugin installation directory |

Plugin variables sit in the precedence chain just below CLI flags and can be overridden via `--var`.

## 7. Context Passing (OUTPUTS)

Steps and substeps may declare OUTPUTS directives for passing data between steps and across delegation boundaries.

### 7.1 OUTPUTS

OUTPUTS declares values to inject into the runbook's live variable space after step completion.

* **Evaluation trigger**: OUTPUTS are evaluated by the XState machine on both PASS and FAIL transitions when the completing step or substep declares outputs.
* **Storage**: Step-level outputs merge into the machine's live `context.variables`; terminal frontmatter outputs are written to `context.finalVars` and persisted to `RunbookState.finalVars`.
* **Expressions**: Each output entry is evaluated against the step's resolved runtime frame. Supported forms: Handlebars expressions (`{{ path "file.json" }}`), quoted literals (`"value"` — may embed Handlebars templates, e.g. `"{{ Index }}"`), bare variable references (`VarName`).
* **Best-effort**: OUTPUTS evaluation is non-fatal. Failed expressions are omitted from the stored result and logged; the step transition is not rolled back.
* **Merge semantics**: Outputs merge into the existing live variable space — new keys are added, existing keys are overwritten.
* **Status visibility**: The `rd status` command includes a `vars` field that exposes the current merged variable space (template vars + step outputs).

### 7.2 Frontmatter `outputs:`

The frontmatter `outputs:` field declares variables to capture at run completion and write to `state.finalVars`.

*   **Evaluation timing**: Evaluated when the runbook reaches a terminal machine transition (`COMPLETE` or `STOPPED`).
*   **Variable space**: Evaluated against the full merged variable space at termination time (template vars + accumulated step outputs + active step/index frame).
*   **Cross-runbook forwarding**: When a child runbook completes, its `state.finalVars` are forwarded to the parent's live variable space via `SET_VARIABLES`, making the child's outputs available to subsequent parent steps.

### 7.3 Delegation Inheritance

Children in a delegation tree inherit the parent's `ContextId` via `--var`, providing a shared identity. Step OUTPUTS accumulate in `state.variables` throughout execution; frontmatter `outputs:` at termination produce `state.finalVars` which propagate to the parent actor on completion.

### 7.5 Example: write-plan / execute-plan

A parent runbook produces a plan file and delegates to a child runbook that consumes it. Both share a `ContextId` through delegation inheritance (see [§7.3](#73-delegation-inheritance) for the hand-off contract — the child automatically inherits the parent's `ContextId` via `--var`).

Parent (`write-plan.runbook.md`):

```markdown
## 1. Write the plan
- OUTPUTS
  - PlanPath {{ path "plan.md" }}
- PASS CONTINUE

Draft the plan and save it to `{{ path "plan.md" }}`.

## 2. Hand off
- ./execute-plan.runbook.md
```

Child (`execute-plan.runbook.md`):

```markdown
---
name: execute-plan
required:
  - PlanPath
---

## 1. Execute
- PASS COMPLETE

Execute the plan stored at `{{ PlanPath }}`.
```

Flow:

1. Parent step 1 runs and its transition completes. The machine evaluates the step's `OUTPUTS`, resolves `PlanPath` via the `{{ path }}` helper (e.g. `.rundown/work/feature-my-work/.rd-a3b8c1d2/2026-02-04-plan.md`), and merges `{ PlanPath: "<resolved path>" }` into the live `context.variables`.
2. Parent step 2 delegates to the child. The child inherits `ContextId=a3b8c1d2` via `--var`, and the plugin forwards the parent's live variable space (including `PlanPath`) as `--var` flags on the child's `rd claim` invocation.
3. Child pipeline setup resolves variables: `--var PlanPath=...` satisfies `required: PlanPath`, and frontmatter `inputs:` defaults fill any gaps.
4. Child step 1 renders `{{ PlanPath }}` as the forwarded value and executes.

## 8. Conformance

1.  **Strict Hierarchy**: H2 -> H3. No H4.
2.  **Sequential IDs**: Numeric steps must be sequential (1, 2, 3...; gaps invalid). Named steps do not participate in sequential numbering.
3.  **Strict Ordering**: OUTPUTS -> FOR -> Transitions -> Prompt -> Body.
4.  **Exclusivity**: Only one body type (Code OR Substeps). Step-level runbook lists are shorthand for Substeps.
5.  **Single Code Block**: Max one code block per step (executable or display-only).
6.  **Loop Safety**: `NEXT` and `BREAK` are valid **only** in FOR substeps and FOR iteration-level transitions. Using them at step level outside any FOR loop is rejected by the validator.
7.  **Source Validation**: FOR clauses referencing a data source must reference a defined source. Named variable required.
8.  **FOR Requires Substeps**: A FOR-annotated step must contain substeps.
9.  **No Nested RETRY**: RETRY fallback actions cannot be RETRY.
10. **FOR Iteration Action Set**: FOR-level nested transitions only allow `CONTINUE`, `DEFER`, `NEXT`, `BREAK`, `GOTO`, `STOP`, `COMPLETE` (plus RETRY wrappers).
11. **Single Directives**: At most one OUTPUTS directive per step or substep.
12. **Reserved Names in Directives**: OUTPUTS variable names must not be reserved names (case-insensitive).
13. **No INPUTS Directive**: The `- INPUTS` step directive has been removed. Use the frontmatter `inputs:` field to declare default variable values; variables are injected via `--var` flags at invocation time.
14. **DELEGATE Ordering**: The `- DELEGATE` annotation must appear after `- FOR` (when present) and before transitions, prompt, and body. Misordered DELEGATE is a parse error. (See §4.3.)
15. **DELEGATE Requires Runbook Target**: Every substep marked `delegate: true` must declare at least one runbook target. A bare DELEGATE substep (no runbook bullet) is rejected at parse time. Step-level DELEGATE propagates to all substeps and the same target requirement applies to every propagated child.
16. **RETRY on DELEGATE is Result-Agnostic**: `rd delegate --retry` succeeds regardless of the substep's prior result. Retry re-issues a fresh token by cancelling the current delegation and re-creating one with a new token; the retry hook propagates the canonical FOR-iteration location through `contextSnapshot.at`.

## 9. Compatibility

Step-level runbook lists are represented internally as sequential substeps (`N.1`, `N.2`, ...). In-progress sessions created before this model are not auto-migrated and must be restarted after upgrade.
