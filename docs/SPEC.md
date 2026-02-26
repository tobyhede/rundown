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

## 2. Steps

Steps are the fundamental units of execution defined by H2 headers.

### 2.1 Identifiers
Steps must be identified sequentially or by name.

| Format | Type | Usage |
| :--- | :--- | :--- |
| `## 1` | Static | Sequential execution. Must start at 1. |
| `## Name` | Named | GOTO target only. Skipped by default flow. |

**Reserved Names**: `NEXT`, `CONTINUE`, `COMPLETE`, `STOP`, `GOTO`, `RETRY`, `PASS`, `FAIL`, `YES`, `NO`, `ALL`, `ANY`, `BREAK`, `FOR`, `IN`, `TO`, `AT`.

Reserved word matching is case-sensitive. `NEXT` is reserved; `Next` and `NextStep` are valid.

Named identifiers must match `/^[A-Za-z_][A-Za-z0-9_]*$/`.

### 2.2 Content Order
Step content must appear in this strict order:
1.  **FOR Annotation**: Loop definition (optional).
2.  **Transitions**: Control flow rules (optional).
3.  **Prompt**: Text instructions.
4.  **Body**: One of: Code Block or Substeps. A step-level runbook list is shorthand for implicit sequential substeps (`.1`, `.2`, ...).

## 3. Step Bodies

A step must contain exactly one type of body content.

### 3.1 Code Blocks
Executes a command or displays a prompt. Max one code block per step.

| Tag | Type | Behavior |
| :--- | :--- | :--- |
| `bash`, `sh`, `shell` | Executable | Runs in shell. Exit 0 = PASS, else FAIL. |
| `bash prompt`, `prompt` | Display | Output only. Not executed. |
| `json`, etc. | Display | Output only. |

Code block info string tags are matched case-insensitively. `BASH`, `Bash`, and `bash` are all treated as executable.

*   **Environment**: Inherits parent environment.
*   **CWD**: Project root.
*   **Stdio**: Inherited.

### 3.2 Substeps
Nested steps defined by H3 (`###`) headers.
*   **Identifiers**: `### 1`, `### 1.1` (sequential), or `### Name` (named).
*   **Aggregation**: Parent step outcome is derived from substeps via transitions (`ALL`/`ANY`).

### 3.3 Runbook List Shorthand
List of external runbooks to execute.
```markdown
- ./deploy-db.runbook.md
- ./deploy-api.runbook.md
```

At step level, this syntax is canonicalized to implicit sequential substeps (`1`, `2`, ...), one workflow per substep.
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

### 3.4 Runtime Target Identity
Runtime dispatch/completion identity is canonicalized as:

`step + substep + iteration`

Execution path notation such as `1.2.1` (`STEP.INDEX.SUBSTEP`) is display-only. It is not authoring syntax and not a canonical identifier.

## 4. Control Flow

Control flow is defined by **Transitions** (conditions) and **Actions** (effects).

### 4.1 Transitions
Syntax: `- {RESULT} [{AGGREGATION}]: {ACTION}`

| Component | Values | Description |
| :--- | :--- | :--- |
| **Result** | `PASS` (`YES`), `FAIL` (`NO`) | Outcome of the step's body. |
| **Aggregation** | `ALL`, `ANY` | For substeps. Step-level runbook-list shorthand is canonicalized to substeps. Default: `PASS ALL`, `FAIL ANY`. |

Aggregation modifiers must form complementary pairs: `PASS ALL` with `FAIL ANY` (pessimistic — any failure stops), or `PASS ANY` with `FAIL ALL` (optimistic — only total failure stops). Non-complementary combinations are invalid because they create evaluation gaps (ALL/ALL) or overlaps (ANY/ANY).

**Defaults**:
*   If only `PASS` defined: `FAIL` -> `STOP`.
*   If only `FAIL` defined: `PASS` -> `CONTINUE`.
*   If neither: `PASS: CONTINUE`, `FAIL: STOP`.

### 4.2 Actions

| Action | Context | Effect |
| :--- | :--- | :--- |
| `CONTINUE` | Any | Proceed to next sequential unit. |
| `STOP [msg]` | Any | Terminate execution immediately (failure). |
| `COMPLETE [msg]` | Any | Terminate execution immediately (success). |
| `GOTO {Target}` | Any | Jump to step/substep (e.g., `1`, `Error`). |
| `RETRY [N] [Act]` | Any | Retry N times (default 1), then perform Action. |
| `NEXT` | FOR Substep | Skip to next iteration. |
| `BREAK` | FOR Substep, FOR Iteration-Level | Exit loop immediately. |

GOTO targeting the containing step (self-reference) without an AT qualifier may create an infinite loop. Use RETRY for bounded re-execution.

**GOTO Syntax**:
*   `GOTO 3`: Jump to Step 3.
*   `GOTO 3` (FOR step, no AT): Defaults to iteration 1.
*   `GOTO 3 AT 1`: Jump to Step 3, iteration 1 (if FOR step).
*   `GOTO 3 AT {{Index}}`: Re-enter Step 3 at current iteration.

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
*   **Named variable required**: Data source FOR clauses require a named variable. Unnamed syntax (`FOR {{source}}`) is invalid.
*   **No descending data sources**: Descending windows (`start > end`) are not supported for data sources.
*   **Data sources**: Provided at runtime as arrays (in-memory) or files (text or JSONL). Resolved against a sources map. See [RUNDOWN.md](./RUNDOWN.md#data-sources) for configuration.
*   **Constraint**: FOR steps MUST have substeps. Step-level runbook-list shorthand qualifies because it is canonicalized to implicit substeps.
*   **Scope**: Loop variable available in substeps as `{{var}}`.
*   **Aggregation**: Transitions on the parent FOR step evaluate the aggregate result of all iterations.
*   **Iteration-level transitions**: Nested `PASS`/`FAIL` transitions under a `FOR` clause execute per iteration. Allowed terminal actions are `CONTINUE`, `BREAK`, `GOTO`, `STOP`, `COMPLETE` (optionally wrapped by `RETRY`).
*   **Nested bullet rule**: Nested bullets under `FOR` must be transition bullets; non-transition nested bullets are invalid and fail parse.
*   **Retry order**: Iteration-level `RETRY` semantics are deterministic: retry first, then execute the exhausted action.
*   **Exit semantics**: Iteration-level `BREAK` includes the current iteration result in parent aggregation. Iteration-level `GOTO`/`STOP`/`COMPLETE` bypass parent aggregation and exit directly.

## 6. Templating

Variables use Handlebars syntax: `{{variable}}`.

| Source | Scope | Description |
| :--- | :--- | :--- |
| CLI (`--var`) | Global | Expanded at startup. |
| `{{Step}}`, `{{step}}` | Step | Current execution identifier for this runbook frame (e.g., `1`, `1.2`). |
| `{{Index}}`, `{{index}}` | Loop | Current iteration number for this runbook frame. |
| `{{context.current.*}}` | Step/Loop | Canonical current-frame context (`step`, `substep`, `index`, `at`). |
| `{{context.parent.*}}` | Nested | Parent frame context when running a child runbook. |
| `{{context.ancestors.N.*}}` | Nested | Ancestor frame context (`0` is nearest parent). |
| `{{context.vars.NAME}}` | Global | User/config/frontmatter variable namespace. |
| Loop Var | Loop | Current item/index (e.g., `{{batch}}`). |

*   **Undefined**: Preserved as literal text.
*   **Evaluation**: Global vars expanded once; Step/Loop vars expanded per iteration.
*   **Path resolution**: Dotted paths are supported consistently (for example `{{context.parent.index}}`).
*   **Reserved keys**: Runtime keys (`step`, `index`, `context`, `Step`, `Index`) are reserved and cannot be overridden by user variables.

## 7. Scenarios

Defined in `scenarios` block (YAML) for testing.

```yaml
scenarios:
  test_name:
    description: "Description"
    commands: ["rd run doc.md", "rd pass"]
    result: COMPLETE
```

## 8. Conformance

1.  **Strict Hierarchy**: H2 -> H3. No H4.
2.  **Sequential IDs**: 1, 2, 3... (gaps invalid).
3.  **Strict Ordering**: FOR -> Transitions -> Prompt -> Body.
4.  **Exclusivity**: Only one body type (Code OR Substeps). Step-level runbook lists are shorthand for Substeps.
5.  **Single Command**: Max one executable block per step.
6.  **Loop Safety**: `NEXT` is only valid inside FOR substeps. `BREAK` is valid in FOR substeps and FOR iteration-level transitions.
7.  **Source Validation**: FOR clauses referencing a data source must reference a defined source. Named variable required.
8.  **FOR Requires Substeps**: A FOR-annotated step must contain substeps.
9.  **No Nested RETRY**: RETRY fallback actions cannot be RETRY.
10. **FOR Iteration Action Set**: FOR-level nested transitions only allow `CONTINUE`, `BREAK`, `GOTO`, `STOP`, `COMPLETE` (plus RETRY wrappers).

## 9. Compatibility

Step-level runbook lists are represented internally as sequential substeps (`N.1`, `N.2`, ...). In-progress sessions created before this model are not auto-migrated and must be restarted after upgrade.
