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

Frontmatter fields beyond `name`, `description`, `version`, `author`, `tags`, and `vars` are preserved (open schema). This allows forward-compatible extensions and user-defined metadata.

The frontmatter `description` field provides a summary for runbook discovery and listing (`rd ls --all`). The `Runbook.description` in the parsed AST is derived from preamble text between the H1 title and first H2 step. These are independent values.

## 2. Steps

Steps are the fundamental units of execution defined by H2 headers.

### 2.1 Identifiers
Steps must be identified sequentially or by name.

| Format | Type | Usage |
| :--- | :--- | :--- |
| `## 1` | Static | Sequential execution. Must start at 1. |
| `## Name` | Named | GOTO target only. Skipped by default flow. |

**Reserved Names**: `NEXT`, `CONTINUE`, `DEFER`, `COMPLETE`, `STOP`, `GOTO`, `RETRY`, `PASS`, `FAIL`, `YES`, `NO`, `ALL`, `ANY`, `BREAK`, `FOR`, `IN`, `TO`, `AT`.

Reserved word matching is case-sensitive. `NEXT` is reserved; `Next` and `NextStep` are valid.

Named identifiers must match `/^[A-Za-z_][A-Za-z0-9_]*$/`.

### 2.2 Content Order
Step content must appear in this strict order:
1.  **FOR Annotation**: Loop definition (optional). Must appear immediately after the step header as a bullet item.
2.  **Transitions**: Control flow rules (optional). Must appear as bullet items immediately after FOR (or after step header if no FOR). Transitions must appear before any prompt text or body content.
3.  **Prompt**: Text instructions.
4.  **Body**: One of: Code Block or Substeps. A step-level runbook list is shorthand for implicit sequential substeps (`.1`, `.2`, ...).

## 3. Step Bodies

A step must contain exactly one type of body content.

Steps are represented as a discriminated union on `kind`: `'base'` (prompt-only), `'command'` (executable code block), `'substeps'` (nested H3 steps), `'for'` (loop with substeps), `'prompted-for'` (unresolved FOR, prompt-only).

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

When only one transition side specifies an aggregation modifier, the defaulted side receives its complement (`PASS ALL` defaults `FAIL ANY`, and vice versa).

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

> **Internal:** The compiler uses a `GOTO NEXT` representation internally to advance to the next step. This cannot be written in markdown syntax — `NEXT` is rejected as a GOTO target by the parser.

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
| `{{context.current.*}}` | Step/Loop | Canonical current runbook context: `step` (e.g., `3`), `substep` (e.g., `1`), `index` (e.g., `3`), `at` (e.g., `3.1[3]`). |
| `{{context.parent.*}}` | Nested | Parent runbook structural context and template variables (`vars.*`). |
| `{{context.ancestors.N.*}}` | Nested | Ancestor runbook contexts (`0` is nearest parent). |
| `{{context.vars.NAME}}` | Global | User/config/frontmatter variable namespace. |
| Loop Var | Loop | Current item/index (e.g., `{{batch}}`). |

*   **Undefined**: Preserved as literal text. A warning is emitted to stderr for each undefined variable.
*   **Evaluation**: Global vars expanded once; Step/Loop vars expanded per iteration.
*   **Parent variables**: `{{context.parent.vars.NAME}}` exposes the parent's resolved template variables. Only non-context keys propagate. Available via both chain (`context.parent.parent.vars.*`) and array (`context.ancestors.N.vars.*`) addressing.
*   **Depth limit**: Parent context chain addressing is capped at 32 levels (enforced on the delegation ancestor chain depth). Exceeding this limit produces an error.
*   **Path resolution**: Dotted paths are supported consistently (for example `{{context.parent.index}}`).
*   **Reserved keys**: Runtime keys `step`, `index`, and `context` are reserved (matching is case-insensitive — any case variant such as `STEP`, `Step`, `INDEX` is also reserved) and cannot be overridden by user variables. The CLI rejects these names in frontmatter `vars:`, `--var` flags, `--var-file` contents, and `.rundown/config.yaml` with an error diagnostic.
*   **Precedence** (highest to lowest):
    1. CLI flags (`--var-file`, `--var`, `--var-json`) — highest priority; within this layer: `--var-json` > `--var` > `--var-file`
    2. `RD_VAR_*` environment variables (prefix stripped)
    3. `.rundown/config.yaml` (auto-discovered)
    4. Frontmatter `vars:` field
    5. Inherited delegation variables (parent context)
    6. Built-in defaults (`Date`, `RunId`, `WorkPath`, etc.)
*   **Environment bridge**: `--var KEY` (without `=`) inherits the value of environment variable `KEY`.

## 7. Conformance

1.  **Strict Hierarchy**: H2 -> H3. No H4.
2.  **Sequential IDs**: Numeric steps must be sequential (1, 2, 3...; gaps invalid). Named steps do not participate in sequential numbering.
3.  **Strict Ordering**: FOR -> Transitions -> Prompt -> Body.
4.  **Exclusivity**: Only one body type (Code OR Substeps). Step-level runbook lists are shorthand for Substeps.
5.  **Single Code Block**: Max one code block per step (executable or display-only).
6.  **Loop Safety**: `NEXT` and `BREAK` are valid in FOR substeps and FOR iteration-level transitions.
7.  **Source Validation**: FOR clauses referencing a data source must reference a defined source. Named variable required.
8.  **FOR Requires Substeps**: A FOR-annotated step must contain substeps.
9.  **No Nested RETRY**: RETRY fallback actions cannot be RETRY.
10. **FOR Iteration Action Set**: FOR-level nested transitions only allow `CONTINUE`, `DEFER`, `NEXT`, `BREAK`, `GOTO`, `STOP`, `COMPLETE` (plus RETRY wrappers).

## 8. Compatibility

Step-level runbook lists are represented internally as sequential substeps (`N.1`, `N.2`, ...). In-progress sessions created before this model are not auto-migrated and must be restarted after upgrade.
