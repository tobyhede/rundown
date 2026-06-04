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

Validate with: `rd check <file>` and `rd resolve <file>`

## Steps

### Identifiers

Prefer numeric step IDs for ordinary sequential workflows:

```markdown
## 1. Install dependencies
## 2. Run tests
```

Use named IDs when a step is mainly a `GOTO` target:

```markdown
## FixFailure. Repair failing checks
- PASS GOTO 2
- FAIL STOP
```

Avoid transition and action words as IDs (`PASS`, `FAIL`, `CONTINUE`, `STOP`, `GOTO`, `RETRY`, etc.). Run `rd check <file>` after editing; it catches invalid IDs and malformed transitions.

Separators between ID and title are flexible: `.`, `:`, `-`, `)`, or space.

### Content Order (strict)

Within a step, put directives before the body:

````markdown
## 1. Produce a plan
- OUTPUTS
  - PlanPath
- PASS CONTINUE
- FAIL STOP

```bash
printf '%s\n' "plan.md" > "$RD_OUTPUTS_PlanPath"
```
````

FOR steps put iteration transitions under the `FOR` directive and use substeps:

```markdown
## 2. Review files
- FOR file IN {{ files }}
  - PASS DEFER
  - FAIL DEFER

### 2.1 Review current file
Review {{ file }}.
```

### Step Types

| Type | Contains | Behavior |
|------|----------|----------|
| **Command** | `bash`/`sh`/`shell` code block (case-insensitive) | Auto-executes; exit code → pass/fail |
| **Prompt** | Text instructions | Requires `rd pass` or `rd fail` |
| **Display-only** | `bash prompt`, `prompt`, `json`, `yaml` blocks | Displayed, NOT executed |

## Context Passing (OUTPUTS)

Data flows forward by author contract:

1. Declare the output name on the producing step.
2. The command writes the value to `RD_OUTPUTS_<Name>`.
3. Later steps read it with `{{ Name }}`.
4. Frontmatter `OUTPUTS:` exports selected values to a parent/delegating runbook.

### Step-level OUTPUTS

Declares values a step or substep will publish for later steps. Step and substep `OUTPUTS` are name-only.

````markdown
## 7. Write plan path
- OUTPUTS
  - PlanPath
- PASS CONTINUE
- FAIL STOP

```bash
printf '%s\n' "plan.json" > "$RD_OUTPUTS_PlanPath"
```
````

After the step passes or fails, later steps can use `{{ PlanPath }}`.

Use `ARTIFACTS` when the runbook should declare file artifacts separately, then list the exported variable name in `OUTPUTS`.

### Frontmatter `OUTPUTS:` — exporting to the parent

Declares which values the runbook exports when it completes. A parent or delegating runbook can receive these values and use them as variables.

```yaml
---
name: write-plan
OUTPUTS:
  - PlanPath
---
```

Combine frontmatter `OUTPUTS:` with a step-level `OUTPUTS` declaration so the runbook produces the value before completion.

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

- `INPUTS:` is a YAML sequence of variable names the runbook accepts. Declarations only — entries do not carry values.
- `REQUIRED:` is a subset of `INPUTS:`. `rd check <file>` reports a required name that is not declared as an input. `rd resolve <file>` reports required inputs that do not have values.

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
| `PASS ALL` / `FAIL ANY` | Every substep must pass; any failed substep makes the parent fail (default) |
| `PASS ANY` / `FAIL ALL` | One successful substep is enough; the parent fails only if every substep fails |

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
- [Runbook patterns and examples](../../../../runbooks/README.md)
- [Template variables](../../../../CLAUDE.md#template-variables)
