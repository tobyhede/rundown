# Project Integration Guide

How to add rundown runbooks to your project.

## Directory Convention

Place runbooks in `.claude/rundown/runbooks/` at your project root:

```text
.claude/rundown/runbooks/
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

Runbooks and scripts in `.claude/rundown/runbooks/` can be committed to share workflows with your team. Runtime state should stay ignored:

```gitignore
# Ignore runtime state, commit runbooks
.claude/rundown/runs/
.claude/rundown/session.json
```

To keep runbooks as local-only project files instead, ignore the entire directory:

```gitignore
.claude/rundown/
```

## Discovery

List all discoverable runbooks (project, plugin, and bundled):

```bash
rd ls --all
```

Output shows NAME, SOURCE, DESCRIPTION, and TAGS columns. Project runbooks appear with source `project`.

Run a runbook by name:

```bash
rd run pr-feedback --var pr_number=42
```

### Priority Chain

When multiple sources provide a runbook with the same name, discovery uses this priority:

1. **Project** (`.claude/rundown/runbooks/`) — highest priority
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
.claude/rundown/runbooks/review/scripts/fetch-data.sh {{repo}}
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
| `vars` | No | Default variable values (overridden by `--var`) |

## Template Variables

Use Handlebars syntax `{{variableName}}` for values that change between runs:

```bash
rd run pr-feedback --var pr_number=11 --var repo=myorg/myrepo
```

Variables defined in frontmatter `vars:` serve as defaults. CLI `--var` flags take precedence.

See CLAUDE.md for full variable source precedence.

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

See [SPEC.md Authoring Conventions](./SPEC.md#authoring-conventions) for the full rationale.

## Worked Example: `pr-feedback`

The `pr-feedback` runbook in `.claude/rundown/runbooks/review/` demonstrates all these conventions:

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
rd check .claude/rundown/runbooks/review/pr-feedback.runbook.md

# Run against a specific PR
rd run pr-feedback --var pr_number=11

# Run scripts independently for testing
bash .claude/rundown/runbooks/review/scripts/fetch-pr-comments.sh tobyhede/rundown 11
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
- Write output to `.work/<runbook-name>/` for intermediate artifacts
- Exit 0 for success (PASS), non-zero for failure (FAIL)
- Keep scripts focused — one responsibility per script
