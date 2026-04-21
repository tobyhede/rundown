---
name: writing-runbooks
description: Use when creating, editing, or authoring rundown runbook files (.runbook.md), or when needing runbook format syntax reference
use_when: Writing, editing, or creating rundown runbook files (.runbook.md). When authoring new runbooks or modifying existing ones.
---

# Writing Runbooks

Rundown runbooks are markdown files (`.runbook.md`) that define executable step-by-step workflows. Steps combine human-readable instructions with machine-executable commands and deterministic control flow.

## Quick Reference

````markdown
---
name: my-runbook
description: What this runbook does
tags:
  - category
inputs:
  environment: staging
---

# Runbook Title

Optional description.

## 1. Step name
- PASS CONTINUE
- FAIL STOP

Instructions for the step.

## 2. Auto-execute step

```bash
npm test
```
````

All frontmatter fields are optional (open schema). Place project runbooks in `.rundown/runbooks/` for discovery (`rd ls --all`).

Validate with: `rd check <file>` and `rd resolve <file>`

## Steps

### Identifiers

| Format | Type | Usage |
|--------|------|-------|
| `## 1` | Static | Sequential execution. Must start at 1. |
| `## ErrorHandler` | Named | GOTO target. Skipped by default flow. |

Named identifiers must match `/^[A-Za-z_][A-Za-z0-9_]*$/`. Reserved words cannot be used as identifiers: `ALL`, `ANY`, `AT`, `BREAK`, `COMPLETE`, `CONTINUE`, `DEFER`, `FAIL`, `FOR`, `GOTO`, `IN`, `NEXT`, `NO`, `PASS`, `RETRY`, `STOP`, `TO`, `YES`. Case-sensitive: `NEXT` is reserved but `Next` is valid. `OF` is a contextual keyword but NOT reserved.

Separators between ID and title are flexible: `.`, `:`, `-`, `)`, space, em dash, right arrow.

### Content Order (strict)

````
## ID. Title
- OUTPUTS             (optional, must be first)
  - Key value-expr
- FOR clause          (optional, after OUTPUTS)
- Transition rules    (optional, must precede body)
Prompt text           (instructions)
```bash              (OR substeps — not both)
command
```
````

### Step Types

| Type | Contains | Behavior |
|------|----------|----------|
| **Command** | `bash`/`sh`/`shell` code block (case-insensitive) | Auto-executes; exit code → pass/fail |
| **Prompt** | Text instructions | Requires `rd pass` or `rd fail` |
| **Display-only** | `bash prompt`, `prompt`, `json`, `yaml` blocks | Displayed, NOT executed |

## Context Passing (OUTPUTS / inputs / outputs)

Steps and substeps may declare OUTPUTS directives to pass data between steps and across a delegation tree. OUTPUTS apply to both H2 steps and H3 substeps. The step-level `- INPUTS` directive has been removed — use the frontmatter `inputs:` field instead.

### OUTPUTS

Declares values to persist after step completion. Evaluated by the machine and merged into the live runbook variable space; FAIL does not suppress OUTPUTS.

```markdown
## 7. Output Path
- OUTPUTS
  - PlanPath {{ path "plan.json" }}
- PASS CONTINUE
- FAIL STOP
```

Output values may be:
- **Helper call**: `{{ path "file.json" }}` (resolves to a context-scoped path)
- **Template variable**: `{{ VarName }}`
- **Quoted literal**: `"value"`
- **Bare variable reference**: `VarName`

Evaluation is non-fatal — failed expressions are omitted and logged; the transition is not rolled back.

### Frontmatter `inputs:` field

Declares default variable values injected at runbook startup (before any step runs):

```yaml
---
name: review-plan
required:
  - PlanPath
inputs:
  environment: staging
  debug: true
---
```

`inputs:` is a key-value map. Defaults sit below CLI `--input`, `RD_INPUT_*`, and config in precedence — CLI always wins. When a parent delegates to a child, the parent's live variable space is forwarded as `--input` flags on the child's `rd claim` command, so child steps see parent OUTPUTS automatically.

Use `required:` alongside `inputs:` when the runbook cannot proceed without the variable (causes a hard error if missing from all sources). Required variables must not appear in `inputs:`.

### Frontmatter `outputs:` field

Declares variables to publish on terminal machine transitions (`COMPLETE` or `STOPPED`). Evaluated values are written to `state.finalVars`, and when the runbook is a delegated child, those values are forwarded into the parent's live variable space via `SET_VARIABLES`.

```yaml
---
name: write-plan
outputs:
  - PlanPath
  - PlanSummary {{ path "summary.txt" }}
---
```

## Transitions

Syntax: `- RESULT [AGGREGATION] ACTION [message]`

### Actions

| Action | Effect |
|--------|--------|
| `CONTINUE` | Proceed to next step |
| `STOP [msg]` | Terminate (failure) |
| `COMPLETE [msg]` | Terminate (success) |
| `GOTO target` | Jump to step/substep |
| `RETRY N action` | Retry N times, then fallback action |
| `DEFER` | Pass result up for aggregation (substeps/FOR only) |
| `NEXT` | Skip to next iteration (FOR only) |
| `BREAK` | Exit loop (FOR only) |

### Defaults

- If only PASS defined: FAIL defaults to STOP
- If only FAIL defined: PASS defaults to CONTINUE
- If neither defined: PASS CONTINUE, FAIL STOP

### Aliases

`YES`/`NO` are aliases for `PASS`/`FAIL` (e.g., `- YES GOTO 1`, `- NO STOP "Unable to fix"`).

## Substeps

Nested steps within a parent step, using H3 headers:

```markdown
## 2. Review changes
- PASS ALL CONTINUE
- FAIL ANY STOP

### 2.1 Code review
Review the implementation.

### 2.2 Test review
Verify test coverage.
```

### Aggregation

| Modifier | Meaning |
|----------|---------|
| `PASS ALL` / `FAIL ANY` | Pessimistic — any failure stops (default) |
| `PASS ANY` / `FAIL ALL` | Optimistic — only total failure stops |

Standalone `- DEFER` shorthand expands to `- PASS DEFER` + `- FAIL DEFER`.

## FOR Loops

Repeat a step across iterations:

```markdown
## 3. Process items
- FOR item IN 1 TO 5
  - PASS DEFER
  - FAIL DEFER

### 3.1 Handle item
Process {{ item }}.
```

### FOR Syntax

| Form | Example |
|------|---------|
| Named range | `FOR i IN 1 TO 10` |
| Unnamed range | `FOR 1 TO 5` |
| Shorthand | `FOR 5` (same as `FOR 1 TO 5`) |
| Descending | `FOR i IN 10 TO 1` |
| Data source | `FOR item IN {{ items }}` |
| Windowed | `FOR item IN 1 TO 3 OF {{ items }}` |

- FOR steps MUST have substeps
- Loop variable available as `{{ var }}` in substeps
- Iteration-level transitions nest under the FOR clause
- Data source FOR requires a named variable

## Template Variables

Use `{{ variableName }}` syntax. See [SPEC.md §6 Templating](../../../../docs/SPEC.md#6-templating) and [§6.1 Built-in Variables](../../../../docs/SPEC.md#61-built-in-variables) for the full reference.

Key authoring notes:
- Undefined variables preserved as literal `{{ variable }}` text
- Frontmatter `inputs:` supports string, number, boolean (not arrays/files)
- Data sources for FOR loops: use `.rundown/config.yaml` or `--input-file`

## Common Mistakes

| Mistake | Fix |
|---------|-----|
| H4+ headings | Only H1 (title), H2 (steps), H3 (substeps) |
| Command block + substeps in same step | Choose one — cannot mix |
| OUTPUTS after transitions | Content order: OUTPUTS → FOR → transitions → body |
| Instructions before transition rules | Content order: OUTPUTS, FOR clause, transitions, then body |
| Reserved word as step ID | `PASS`, `FAIL`, `CONTINUE`, etc. are reserved |
| Skipping `rd check` | Always validate: `rd check <file>` |

## Reference

- [Rundown specification](../../../../docs/SPEC.md)
- [Format grammar (EBNF)](../../../../docs/FORMAT.md)
- [Runbook patterns and examples](../../../../runbooks/README.md)
- [Template variables](../../../../docs/SPEC.md#6-templating) — precedence, reserved keys, required variables
- [Built-in variables](../../../../docs/SPEC.md#61-built-in-variables) — `Date`, `WorkPath`, `ContextId`, `Step`, `Index`, etc.
