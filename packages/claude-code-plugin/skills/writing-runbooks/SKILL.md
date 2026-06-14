---
name: writing-runbooks
description: Use when creating, editing, or authoring rundown runbook files (.runbook.md), or when needing runbook format syntax reference
---

# Writing Runbooks

Rundown runbooks are markdown files (`.runbook.md`) that define executable step-by-step workflows. Steps combine human-readable instructions with machine-executable commands and deterministic control flow.

## When to Use

- Creating a new `.runbook.md` file from scratch
- Editing or refactoring an existing runbook's steps, transitions, `INPUTS`/`OUTPUTS`, `ARTIFACTS`, or FOR loops
- Looking up Rundown format syntax (directives, transitions, artifacts, delegation, frontmatter)

## When NOT to Use

- Executing or stepping through an active runbook — use the [running-runbooks](../running-runbooks/SKILL.md) skill instead
- Orchestrating parent-side delegation to child agents — use the [delegating-runbooks](../delegating-runbooks/SKILL.md) skill instead
- Planning the work before a runbook exists — use the [writing-plans](../writing-plans/SKILL.md) skill when applicable

## House Style

This skill documents Rundown *syntax*. For the idiomatic *conventions* — how the directives combine in practice — follow **[house-style.md](house-style.md)**, distilled from the canonical `end-to-end-test/` and `planning/` plugin runbooks. Read it before authoring a new runbook. Headline conventions:

- **Schema-first artifact pipeline:** bind the schema (step 1) → rehydrate inputs → write to `{{ path Alias }}` → validate with `PASS COMPLETE` / `FAIL GOTO <write-step>` (produce → validate → retry loop).
- **One runbook, one artifact** with a full frontmatter contract (`INPUTS` / `REQUIRED` / `OUTPUTS`); compose small leaves from a parent.
- **Reference `{{ path Alias }}`, never hardcoded paths;** aliases are PascalCase `*Path` / `*Paths`.
- **Delegate the fan-out, then delegate collation** — never collate from the parent.
- **Record-don't-gate review steps** use `FAIL CONTINUE`.

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

## Context Passing

Data flows forward by author contract:

1. Declare the output name on the producing step.
2. The command writes the value to `RD_OUTPUTS_<Name>`.
3. Later steps read it with `{{ Name }}`.
4. Frontmatter `OUTPUTS:` exports selected values to a parent/delegating runbook.

### Step/Substep `ARTIFACTS`

`ARTIFACTS` declares structured artifact aliases for the step or substep being entered. It is valid only on H2 steps and H3 substeps, never in frontmatter, and must be the first directive after the heading. It resolves at step/substep entry, writing structured artifact variables and manifest rows — it does **not** write file contents. Producers write managed artifact content to the path rendered by `{{ path Alias }}`.

````markdown
## 2. Write plan
- ARTIFACTS
  - PlanPath "plan.json"
- PASS CONTINUE
- FAIL STOP

```bash
printf '{"ok":true}\n' > "{{ path PlanPath }}"
```
````

Token forms in brief: `Name` (rehydrate an existing reference), `Name "plan.json"` (managed key), `Name "review-*.json"` (read-only wildcard selector), plus file-path and `rd://` URI references. Render with `{{ path Alias }}` (local path) or `{{ artifact Alias }}` (URI). For the full token-form catalogue, rendering-helper table, and producer/consumer examples, see **[artifacts.md](artifacts.md)**.

### Step/Substep `OUTPUTS`

`OUTPUTS` declares the name-only values a step or substep publishes for later steps. The command writes each value to its `RD_OUTPUTS_<Name>` channel; Rundown merges them after the command completes. Do not write managed artifact contents to `RD_OUTPUTS_*` — write artifact files to `{{ path Alias }}`.

````markdown
## 7. Capture summary
- OUTPUTS
  - Summary
- PASS CONTINUE
- FAIL STOP

```bash
printf 'ready\n' > "$RD_OUTPUTS_Summary"
```
````

After the step passes or fails, later steps can use `{{ Summary }}`.

### Frontmatter `OUTPUTS:` — exporting to the parent

Declares which values the runbook exports when it completes. A parent or delegating runbook can receive these values and use them as variables.

```yaml
---
name: write-plan
OUTPUTS:
  - PlanPath
---
```

Combine frontmatter `OUTPUTS:` with a step-level `OUTPUTS` or `ARTIFACTS` declaration so the runbook produces the value before completion.

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

Variable resolution precedence (highest → lowest): explicit invocation values (`--input`, `--input-json`, `--input-file`), plugin variables, `RD_INPUT_*`, inherited delegation variables, project `.rundown/config.yaml`, built-in defaults, context-output fill-gap values.

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

## DELEGATE

Use bare `- DELEGATE` to delegate a step or substep. `DELEGATE value` is invalid. Place `- DELEGATE` after `FOR` on H2 steps and after `OUTPUTS` on H3 substeps, before transitions, prompt text, or body content.

An H2 `DELEGATE` propagates to its substeps. Delegated targets must resolve to runbooks; do not use delegation for arbitrary files or commands.

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
| ARTIFACTS after OUTPUTS or transitions | H2 order: ARTIFACTS → OUTPUTS → FOR → DELEGATE → transitions → prompt → body. H3 order omits FOR. |
| OUTPUTS expression form in a step/substep (`- Name {{ expr }}`) | Step/substep `OUTPUTS` entries are bare names only. Use frontmatter `OUTPUTS:` for export expressions. |
| Writing artifact contents to `RD_OUTPUTS_*` | Write managed artifact files to `{{ path ArtifactAlias }}`. Use `RD_OUTPUTS_*` only for command output channel values. |
| Using naked `ARTIFACTS` as creation (`- PlanPath`) | Naked `ARTIFACTS` asserts/rehydrates an already-bound artifact reference. Use `- PlanPath "plan.json"` to create a managed artifact record. |
| Assuming `FOR` works on substeps | `FOR` is valid only on H2 steps. Put iteration on the parent step and work inside H3 substeps. |
| Writing `DELEGATE value` | Use bare `- DELEGATE`; the target is resolved from the delegated step/substep context. |
| Confusing artifact URI and path rendering | `{{ Alias }}` (direct) and `{{ path Alias }}` render local filesystem paths; only `{{ artifact Alias }}` renders artifact URI values. |
| Broken fenced examples inside fenced docs | When documenting a runbook inside a code fence, use a longer outer fence, such as four backticks around examples containing triple-backtick command blocks. |
| Reserved word as step ID | `PASS`, `FAIL`, `CONTINUE`, etc. are reserved |
| `INPUTS:` written as a key→default map (`VarName: default`) | `INPUTS:` is a YAML sequence of bare names (`- VarName`). Defaults live in config / `--input-file` / `--input-json` / env, not in frontmatter. |
| Name in `REQUIRED:` not declared in `INPUTS:` | `REQUIRED:` must be a subset of `INPUTS:`. Add the name to `INPUTS:` too. |
| Skipping `rd check` | Always validate: `rd check <file>` |

## Reference

- [Rundown specification](../../../../docs/spec/language.md)
- [Runbook patterns and examples](../../../../runbooks/README.md)
- [Template variables](../../../../CLAUDE.md#template-variables)
