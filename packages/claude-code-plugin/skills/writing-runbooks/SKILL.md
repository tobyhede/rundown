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
INPUTS:
  - environment
  - PlanPath
REQUIRED:
  - PlanPath
OUTPUTS:
  - ResultPath
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

### Frontmatter casing convention

| Casing | Fields | Reason |
|--------|--------|--------|
| **UPPERCASE** | `INPUTS`, `OUTPUTS`, `REQUIRED` | Load-bearing runtime parameters; mirrors the step-level `- OUTPUTS`/`- FOR` directive style |
| **lowercase** | `name`, `description`, `version`, `author`, `tags`, `skill` | Static metadata |

The parser case-normalizes known keys, so both forms parse identically — the convention is purely for human readability.

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
- OUTPUTS             (optional, must precede FOR / transitions)
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

## Context Passing (OUTPUTS)

Data flows forward through two coordinated mechanisms — between steps in the same run, and from a child runbook back to its parent in a delegation tree.

### Step-level OUTPUTS

Declares values to publish into the run's live variable space after a step PASSes. Applies to both H2 steps and H3 substeps. FAIL skips OUTPUTS evaluation entirely.

```markdown
## 7. Output Path
- ARTIFACTS
  - PlanPath "plan.json"
- OUTPUTS
  - PlanPath
- PASS CONTINUE
- FAIL STOP
```

After PASS, `PlanPath` is added to `state.variables` and is available to every later step in the same run as `{{ PlanPath }}`.

At step/substep level, `OUTPUTS` is name-only:
- **Naked form (file-backed channel)**: `PlanPath` — pre-creates a file at `.rundown/runs/<runId>/outputs/<stepId>/<VarName>` and exports its absolute path as `RD_OUTPUTS_<VarName>` to the spawned shell. The command writes the value into that file; on exit, Rundown reads, trims, and merges it.

Use `ARTIFACTS` to declare structured artifact paths/keys (for example: `PlanPath "plan.json"`), then list the alias in `OUTPUTS`.

### Frontmatter `OUTPUTS:` — exporting to the parent

Declares which variables the runbook exports at terminal completion. The listed names are read from `state.variables`, written to `state.finalVars`, and forwarded into the parent delegation's variable space via `SET_VARIABLES`.

```yaml
---
name: write-plan
OUTPUTS:
  - PlanPath
---
```

Combine with a step-level OUTPUTS so the value lands in `state.variables` first, then exports at completion.

### Frontmatter `INPUTS:` and `REQUIRED:` — declaring what a runbook needs

```yaml
---
name: review-plan
INPUTS:
  - PlanPath
  - environment
REQUIRED:
  - PlanPath
---
```

- `INPUTS:` is a YAML sequence of variable names the runbook accepts. Declarations only — entries do not carry values. Names must match `/^[a-zA-Z_][a-zA-Z0-9_]*$/` and must not collide with reserved/built-in names.
- `REQUIRED:` is a subset of `INPUTS:`. Every name in `REQUIRED:` must also appear in `INPUTS:` — mismatch is a parse-time error. Missing values trigger a hard `MISSING_REQUIRED_VARS` error at resolution.

Defaults are not carried in frontmatter. Provide values via `--input`, `--input-json`, `--input-file`, `RD_INPUT_*` env, parent-forwarded variables (from a parent runbook's `OUTPUTS:`), or project `.rundown/config.yaml`.

Variable resolution precedence (highest → lowest): CLI `--input` / `--input-json` / `--input-file`, `RD_INPUT_*` env, parent-forwarded variables, project `.rundown/config.yaml`, built-in defaults.

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

Use `{{ variableName }}` syntax. See [CLAUDE.md — Template Variables](../../../../CLAUDE.md#template-variables) for full reference.

Key authoring notes:
- Undefined variables preserved as literal `{{ variable }}` text
- Frontmatter `INPUTS:` declares names only — defaults come from `.rundown/config.yaml`, `--input`, `--input-json`, `--input-file`, or `RD_INPUT_*` env
- Data sources for FOR loops: use `--input-json` for inline arrays, or `.rundown/config.yaml` / `--input-file` for arrays and `file:` values

## Common Mistakes

| Mistake | Fix |
|---------|-----|
| H4+ headings | Only H1 (title), H2 (steps), H3 (substeps) |
| Command block + substeps in same step | Choose one — cannot mix |
| OUTPUTS after transitions | Content order: OUTPUTS → FOR → transitions → body |
| Reserved word as step ID | `PASS`, `FAIL`, `CONTINUE`, etc. are reserved |
| `INPUTS:` written as a key→default map (`VarName: default`) | `INPUTS:` is a YAML sequence of bare names (`- VarName`). Defaults live in config / `--input-file` / `--input-json` / env, not in frontmatter. |
| Name in `REQUIRED:` not declared in `INPUTS:` | `REQUIRED:` must be a subset of `INPUTS:`. Add the name to `INPUTS:` too. |
| Skipping `rd check` | Always validate: `rd check <file>` |

## Reference

- [Rundown specification](../../../../docs/spec/language.md)
- [Format grammar (EBNF)](../../../../docs/spec/grammar.md)
- [Runbook patterns and examples](../../../../runbooks/README.md)
- [Template variables](../../../../CLAUDE.md#template-variables)
