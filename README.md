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
  <a href="https://www.npmjs.com/package/@rundown-org/cli">
    <img src="https://img.shields.io/npm/v/@rundown-org/cli.svg" alt="Current npm package version." />
  </a>
  <a href="https://coderabbit.ai">
    <img src="https://img.shields.io/coderabbit/prs/github/tobyhede/rundown" alt="CodeRabbit Reviews." />
  </a>
</p>


## Why Rundown?

Rundown transforms static documentation into interactive, stateful CLI runbook flows, bridging the gap between "how-to" and "done."

*   **Human-Readable:** Write standard Markdown.
*   **Agent-Readable:** Write standard Markdown.
*   **Machine-Executable:**  Rundown CLI executes and enforces your process.
*   **Stateful:** It remembers where you left off. Close your terminal, reboot your machine, and `rundown status` picks right back up.
*   **Agent-Ready:** Designed to be the perfect "runtime" for AI agents (like Claude) to execute long-running, complex tasks reliably.

## Features

- **Markdown-based runbooks** - Define multi-step processes in readable `.runbook.md` files
- **State persistence** - Runbook progress survives context clears
- **XState compilation** - Runbooks compile to state machines for reliable execution
- **CLI control** - Simple commands to run, pass, fail, and navigate runbooks
- **Template variables** - Parameterize runbooks with `{{variable}}` syntax

## Security

Rundown includes a Deno-inspired security policy layer that provides explicit allowlist-based permission control:

- **Default-deny** - Commands not in the allowlist require user confirmation
- **Granular control** - Separate allow/deny lists for commands, file access, and environment variables
- **Runbook overrides** - Per-runbook policy configurations for different trust levels
- **CI-friendly** - `--yes` flag for non-interactive execution with pre-approved commands

**Key CLI flags:**
- `--allow-run <cmds>` - Allow specific commands
- `--allow-all` / `--deny-all` - Trust or strict mode
- `--policy <file>` - Custom policy file
- `--non-interactive` - CI mode (auto-deny)

See [Security Documentation](docs/SECURITY.md) for full configuration options.

## Get Started

### Install

```bash
npm install -g @rundown-org/cli
```

### Create Your First Runbook

Create a runbook file `deploy.runbook.md`.

This example uses `rd echo` to simulate commands so you can run it immediately without any setup.

````markdown
---
name: Deploy to Production
---

## 1. Run Tests
- PASS CONTINUE
- FAIL STOP

```bash
rd echo npm test
```

## 2. Build Application
- PASS CONTINUE
- FAIL STOP

```bash
rd echo npm run build
```

## 3. Deploy
- PASS COMPLETE
- FAIL STOP

```bash
rd echo npm run deploy
```
````

Run the runbook:

```bash
rundown run deploy.runbook.md
```

**To make this real:** Simply remove `rd echo` from the code blocks to execute the actual `npm` commands.

## Commands

The `rd` command is an alias for `rundown`.

| Command | Description |
|---------|-------------|
| `rundown run [file]` | Start a runbook |
| `rundown run [file] --var key=value` | Set template variable (repeatable) |
| `rundown run [file] --var-file path` | Load variables from YAML file |
| `rundown run [file] --prompted` | Show commands without auto-executing |
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
| `rundown ls` | Output as JSON for programmatic use (default) |
| `rundown ls --tags <tags>` | Filter runbooks by comma-separated tags |
| `rundown check <file>` | Validate runbook file |
| `rundown echo` | Test helper: echo with configurable result |
| `rundown prune` | Remove stale runbook state files |
| `rundown scenario <cmd>` | List, show, or run scenarios |
| `rundown scenario-suite <cmd>` | List, show, or run scenario suite cases |
| `rundown prompt <content>` | Output content in markdown fences |
| `rundown delegate <runbook> --step <id>` | Delegate substep to child runbook |
| `rundown claim <token>` | Claim a delegation token and launch child |
| `rundown abort <token>` | Cancel a delegation token |

## Packages

| Package | Description |
|---------|-------------|
| [@rundown-org/parser](packages/parser) | Markdown runbook parser |
| [@rundown-org/core](packages/core) | Runbook state management and XState compilation |
| [@rundown-org/cli](packages/cli) | Command-line interface |
| [@rundown-org/mcp](packages/mcp) | MCP server for AI agent integration |
| [@rundown-org/claude-code-plugin](packages/claude-code-plugin) | Claude Code plugin for runbook orchestration |

## Documentation

- [SPEC.md](docs/SPEC.md) - Rundown format specification
- [FORMAT.md](docs/FORMAT.md) - Formal BNF-style grammar
- [MCP.md](docs/MCP.md) - MCP server reference
- [SECURITY.md](docs/SECURITY.md) - Security policy configuration
- [RUNDOWN.md](docs/RUNDOWN.md) - Rundown internal architecture
- [CLI-OUTPUT-SPEC.md](docs/CLI-OUTPUT-SPEC.md) - CLI output format specification
- [SCRIPTING.md](docs/SCRIPTING.md) - Scripting and automation guide
- [AGENT-ORCHESTRATION.md](docs/AGENT-ORCHESTRATION.md) - Subagent delegation, context discovery, and delegation completion
- [PROJECT-INTEGRATION.md](docs/PROJECT-INTEGRATION.md) - Project integration guide
- [DOCKER.md](docs/DOCKER.md) - Docker verification pipeline
- [SCENARIOS.md](docs/SCENARIOS.md) - Scenarios and test runbook standard
- [Runbook Patterns](runbooks/README.md) - Runbook authoring patterns

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for instructions on setting up the development environment and running tests.

## License

MIT
