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

### 2.2 Content Order
Step content must appear in this strict order:
1.  **FOR Annotation**: Loop definition (optional).
2.  **Transitions**: Control flow rules (optional).
3.  **Prompt**: Text instructions.
4.  **Body**: One of: Code Block, Substeps, or Runbooks.

## 3. Step Bodies

A step must contain exactly one type of body content.

### 3.1 Code Blocks
Executes a command or displays a prompt. Max one code block per step.

| Tag | Type | Behavior |
| :--- | :--- | :--- |
| `bash`, `sh` | Executable | Runs in shell. Exit 0 = PASS, else FAIL. |
| `bash prompt` | Display | Output only. Not executed. |
| `json`, etc. | Display | Output only. |

*   **Environment**: Inherits parent environment.
*   **CWD**: Project root.
*   **Stdio**: Inherited.

### 3.2 Substeps
Nested steps defined by H3 (`###`) headers.
*   **Identifiers**: `### 1`, `### 1.1` (sequential), or `### Name` (named).
*   **Aggregation**: Parent step outcome is derived from substeps via transitions (`ALL`/`ANY`).

### 3.3 Runbooks
List of external runbooks to execute.
```markdown
- ./deploy-db.runbook.md
- ./deploy-api.runbook.md
```

## 4. Control Flow

Control flow is defined by **Transitions** (conditions) and **Actions** (effects).

### 4.1 Transitions
Syntax: `- {RESULT} [{AGGREGATION}]: {ACTION}`

| Component | Values | Description |
| :--- | :--- | :--- |
| **Result** | `PASS` (`YES`), `FAIL` (`NO`) | Outcome of the step's body. |
| **Aggregation** | `ALL`, `ANY` | For substeps/runbooks. Default: `PASS ALL`, `FAIL ANY`. |

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
| `BREAK` | FOR Substep | Exit loop immediately. |

**GOTO Syntax**:
*   `GOTO 3`: Jump to Step 3.
*   `GOTO 3 AT 1`: Jump to Step 3, iteration 1 (if FOR step).
*   `GOTO 3 AT {{Index}}`: Re-enter Step 3 at current iteration.

## 5. Iteration (FOR)

Steps annotated with `FOR` execute their substeps repeatedly.
Syntax: `- FOR {VAR} IN {RANGE}`

| Syntax | Range | Example |
| :--- | :--- | :--- |
| `1 TO N` | Numeric | `FOR i IN 1 TO 5` |
| `N TO 1` | Descending | `FOR i IN 5 TO 1` |
| `{{Source}}` | Data Source | `FOR item IN {{items}}` |
| `N OF {{Source}}` | Windowed | `FOR item IN 1 TO 5 OF {{items}}` |

*   **Constraint**: FOR steps MUST have substeps.
*   **Scope**: Loop variable available in substeps as `{{var}}`.
*   **Aggregation**: Transitions on the parent FOR step evaluate the aggregate result of all iterations.

## 6. Templating

Variables use Handlebars syntax: `{{variable}}`.

| Source | Scope | Description |
| :--- | :--- | :--- |
| CLI (`--var`) | Global | Expanded at startup. |
| `{{Step}}` | Step | Current step ID (e.g., `1.2`). |
| `{{Index}}` | Loop | Current iteration number. |
| Loop Var | Loop | Current item/index (e.g., `{{batch}}`). |

*   **Undefined**: Preserved as literal text.
*   **Evaluation**: Global vars expanded once; Step/Loop vars expanded per iteration.

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
4.  **Exclusivity**: Only one body type (Code OR Substeps OR Runbooks).
5.  **Single Command**: Max one executable block per step.
6.  **Loop Safety**: `NEXT`/`BREAK` only valid inside FOR substeps.