<p align="center">
  <img src="logo.png" alt="Rundown Logo" width="200">
</p>

<h1 align="center">Rundown</h1>

<p align="center">
  <strong>Executable Workflows from Markdown Runbooks</strong><br>
  Enforce process. Track progress. Resume anytime.
</p>

## Features

- **Markdown-based workflows** - Define multi-step processes in readable `.runbook.md` files
- **State persistence** - Workflow progress survives context clears
- **XState compilation** - Workflows compile to state machines for reliable execution
- **CLI control** - Simple commands to run, pass, fail, and navigate workflows

## Installation

```bash
npm install -g @rundown/cli
```

## Quick Start

Create a workflow file `deploy.runbook.md`:

```markdown
---
title: Deploy to Production
---

## 1. Run Tests

```bash
npm test
```

- PASS: CONTINUE
- FAIL: STOP

## 2. Build Application

```bash
npm run build
```

- PASS: CONTINUE
- FAIL: STOP

## 3. Deploy

```bash
npm run deploy
```

- PASS: COMPLETE
- FAIL: STOP
```

Run the workflow:

```bash
rundown run deploy.runbook.md
```

## Commands

The `rd` command is an alias for `rundown`.

| Command | Description |
|---------|-------------|
| `rundown run <file>` | Start a workflow |
| `rundown pass` | Mark current step as passed (evaluates PASS condition) |
| `rundown fail` | Mark current step as failed (evaluates FAIL condition) |
| `rundown goto <n>` | Jump to step number |
| `rundown status` | Show current state |
| `rundown stop` | Abort workflow |
| `rundown complete` | Mark workflow as complete |
| `rundown stash` | Pause enforcement (stash active workflow) |
| `rundown pop` | Resume enforcement (restore stashed workflow) |
| `rundown ls` | List active workflows |
| `rundown ls --all` | List available workflow files |
| `rundown ls --json` | Output as JSON for programmatic use |
| `rundown ls --tags <tags>` | Filter workflows by comma-separated tags |
| `rundown check <file>` | Validate workflow file |

## Packages

| Package | Description |
|---------|-------------|
| [@rundown/parser](packages/parser) | Markdown workflow parser |
| [@rundown/core](packages/core) | Workflow state management |
| [@rundown/cli](packages/cli) | Command-line interface |

## Documentation

- [SPEC.md](docs/SPEC.md) - Rundown format specification

## License

MIT
