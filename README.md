# Rundown

A format for defining executable workflows using Markdown.

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

| Command | Description |
|---------|-------------|
| `rundown run <file>` | Start a workflow |
| `rundown pass` | Mark current step as passed |
| `rundown fail` | Mark current step as failed |
| `rundown goto <n>` | Jump to step number |
| `rundown status` | Show current state |
| `rundown stop` | Abort workflow |
| `rundown ls` | List active workflows |
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
