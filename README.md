<p align="center">
  <img src="logo.png" alt="Rundown Logo" width="400">
</p>
<p align="center">
  <strong>Executable Runbooks from Markdown</strong><br>
  Enforce process. Track progress. Resume anytime.
</p>

<p align="center">
  <a href="https://github.com/tobyhede/rundown/blob/main/LICENSE">
    <img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="Rundown is released under the MIT license." />
  </a>
  <a href="https://www.npmjs.com/package/@rundown/cli">
    <img src="https://img.shields.io/npm/v/@rundown/cli.svg" alt="Current npm package version." />
  </a>
</p>

> **Note:** Rundown is currently in **Alpha**. APIs and formats may change.

## Why Rundown?

Shell scripts are brittle. Wikis are ignored. Rundown bridges the gap:

*   **Human-Readable:** Write standard Markdown.
*   **Machine-Executable:** The CLI runs your code blocks and enforces your process.
*   **Stateful:** It remembers where you left off. Close your terminal, reboot your machine, and `rundown status` picks right back up.
*   **Agent-Ready:** Designed to be the perfect "runtime" for AI agents (like Claude) to execute long-running, complex tasks reliably.

## Features

- **Markdown-based runbooks** - Define multi-step processes in readable `.runbook.md` files
- **State persistence** - Runbook progress survives context clears
- **XState compilation** - Runbooks compile to state machines for reliable execution
- **CLI control** - Simple commands to run, pass, fail, and navigate runbooks

## Installation

```bash
npm install -g @rundown/cli
```

## Quick Start

Create a runbook file `deploy.runbook.md`:

```markdown
---
name: Deploy to Production
---

## 1. Run Tests
- PASS: CONTINUE
- FAIL: STOP

```bash
npm test
```

## 2. Build Application
- PASS: CONTINUE
- FAIL: STOP

```bash
npm run build
```

## 3. Deploy
- PASS: COMPLETE
- FAIL: STOP

```bash
npm run deploy
```
```

Run the runbook:

```bash
rundown run deploy.runbook.md
```

## Commands

The `rd` command is an alias for `rundown`.

| Command | Description |
|---------|-------------|
| `rundown run <file>` | Start a runbook |
| `rundown pass` | Mark current step as passed (evaluates PASS condition) |
| `rundown fail` | Mark current step as failed (evaluates FAIL condition) |
| `rundown goto <n>` | Jump to step number |
| `rundown status` | Show current state |
| `rundown stop [message]` | Abort runbook with optional message |
| `rundown complete [message]` | Mark runbook as complete with optional message |
| `rundown stash` | Pause enforcement (stash active runbook) |
| `rundown pop` | Resume enforcement (restore stashed runbook) |
| `rundown ls` | List active runbooks |
| `rundown ls --all` | List available runbook files |
| `rundown ls --json` | Output as JSON for programmatic use |
| `rundown ls --tags <tags>` | Filter runbooks by comma-separated tags |
| `rundown check <file>` | Validate runbook file |

## Packages

| Package | Description |
|---------|-------------|
| [@rundown/parser](packages/parser) | Markdown runbook parser |
| [@rundown/core](packages/core) | Runbook state management |
| [@rundown/cli](packages/cli) | Command-line interface |

## Documentation

- [SPEC.md](docs/SPEC.md) - Rundown format specification

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for instructions on setting up the development environment and running tests.

## License

MIT
