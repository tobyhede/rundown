# Project Integration Guide

How to add rundown runbooks to your project.

## Directory Convention

Place runbooks in `.rundown/runbooks/` at your project root:

```text
.rundown/runbooks/
  README.md                              # Convention explainer
  review/
    pr-feedback.runbook.md               # Workflow orchestration
    scripts/
      fetch-pr-comments.sh              # Implementation script
      summarize-findings.sh             # Implementation script
  deploy/
    staging.runbook.md
    scripts/
      health-check.sh
```

Subdirectory structure is supported — runbooks are discovered recursively.

### Version Control

Runbooks and scripts in `.rundown/runbooks/` can be committed to share workflows with your team. Runtime state should stay ignored:

```gitignore
# Ignore runtime state, commit runbooks
.rundown/work/
.rundown/runs/
.rundown/session.json
.rundown/locks/
```

To keep runbooks as local-only project files instead, ignore the entire directory:

```gitignore
.rundown/
```

## Discovery

List all discoverable runbooks (project, plugin, and bundled):

```bash
rd ls --all
```

Output shows NAME, SOURCE, DESCRIPTION, and TAGS columns. Project runbooks appear with source `project`.

Run a runbook by name:

```bash
rd run pr-feedback --input pr_number=42
```

### Priority Chain

When multiple sources provide a runbook with the same name, discovery uses this priority:

1. **Project** (`.rundown/runbooks/`) — highest priority
2. **Plugin** (`$CLAUDE_PLUGIN_ROOT/runbooks/`)
3. **Bundled** (CLI package `dist/runbooks/`)

Use namespace syntax for explicit targeting:

```bash
rd run write-plan              # Resolves via priority chain
rd run rundown:write-plan      # Explicit: from plugin only
```

## Recommended Structure

**Principle**: Runbook code blocks should be one-liners that call scripts. This keeps runbooks readable as workflow documentation while scripts handle implementation complexity.

```markdown
## 1 Fetch Data
- PASS CONTINUE
- FAIL STOP

```bash
.rundown/runbooks/review/scripts/fetch-data.sh {{repo}}
```
```

Benefits:
- Runbooks read as **workflow documentation** — steps, transitions, and intent
- Scripts are **testable independently** — `bash scripts/fetch-data.sh myrepo`
- Separation of concerns — change implementation without touching workflow

## Frontmatter

Every runbook should have frontmatter with at minimum `name` and `description`:

```yaml
---
name: pr-feedback
description: Fetch, parse, and triage PR review feedback from GitHub
tags:
  - review
  - github
vars:
  repo: tobyhede/rundown
  pr_number: ""
---
```

| Field | Required | Description |
|-------|----------|-------------|
| `name` | Yes | Unique identifier used with `rd run <name>` |
| `description` | Yes | Shown in `rd ls --all` output |
| `tags` | No | Categorization labels |
| `vars` | No | Default variable values (overridden by `--input`) |

## Template Variables

Use Handlebars syntax `{{variableName}}` for values that change between runs:

```bash
rd run pr-feedback --input pr_number=11 --input repo=myorg/myrepo
```

Variables defined in frontmatter `vars:` serve as defaults. CLI `--input` flags take precedence.

See [docs/reference/runtime.md Variable Sources](../reference/runtime.md#variable-sources) for the full variable source precedence.

#### Data Sources in Configuration

Arrays and `file:`-prefixed values in configuration enable FOR loop data sources:

```yaml
# .rundown/config.yaml
environment: staging
items:
  - alpha
  - bravo
  - charlie
log_file: file:data/results.jsonl
```

Arrays become data sources for `FOR item IN {{ items }}`. The `file:` prefix creates file-backed sources. Scalar values remain regular template variables.

Or pass arrays inline with `--input-json`:

```bash
rd run runbook.md --input-json 'items=["alpha","bravo","charlie"]'
```

## Authoring Conventions

### Always write explicit transitions

Write both PASS and FAIL on every step, even when they match the defaults (`PASS CONTINUE`, `FAIL STOP`). Transitions are the most important part of understanding a runbook's control flow at a glance.

```markdown
## 1 Build
- PASS CONTINUE
- FAIL STOP
```

### Messages: only when they add information

STOP and COMPLETE accept optional messages. Include a message only when it provides context the step title does not — typically actionable guidance (what went wrong, what to check, what to do next). Omit when the step title makes the outcome self-evident.

```markdown
## 1 Authenticate
- FAIL STOP "Check that gh is authenticated: run gh auth status"
```

Not:
```markdown
## 1 Compile
- FAIL STOP "Compilation failed."
```

See [docs/spec/grammar.md Messages](../spec/grammar.md#messages) for the full rationale.

## Worked Example: `pr-feedback`

The `pr-feedback` runbook in `.rundown/runbooks/review/` demonstrates all these conventions:

**Runbook** (`pr-feedback.runbook.md`):
- Frontmatter with name, description, tags, and default variables
- Steps that delegate to colocated scripts
- Static sequential steps (fetch, summarize, address, finalize)
- Template variables (`{{repo}}`, `{{pr_number}}`) for parameterization

**Scripts** (`scripts/`):
- `fetch-pr-comments.sh` — Uses `gh api` to fetch PR review comments as JSONL
- `summarize-findings.sh` — Parses comments into structured findings with severity/source classification

**Usage**:

```bash
# List available runbooks
rd ls --all

# Check syntax
rd check .rundown/runbooks/review/pr-feedback.runbook.md

# Run against a specific PR
rd run pr-feedback --input pr_number=11

# Run scripts independently for testing
bash .rundown/runbooks/review/scripts/fetch-pr-comments.sh tobyhede/rundown 11
```

## Colocated Scripts

Scripts live alongside their runbook in a `scripts/` directory:

```text
review/
  pr-feedback.runbook.md
  scripts/
    fetch-pr-comments.sh
    summarize-findings.sh
```

Guidelines:
- Use `#!/usr/bin/env bash` and `set -euo pipefail`
- Accept parameters positionally with usage messages
- By default write output to `.rundown/work/<runbook-name>/` for intermediate artifacts; override via the `WorkPath` template variable (set with `--input WorkPath=...` or config) or the `WORK_PATH` environment variable read by scripts
- Exit 0 for success (PASS), non-zero for failure (FAIL)
- Keep scripts focused — one responsibility per script
