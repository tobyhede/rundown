# CLAUDE.md

Rundown is a format for defining executable workflows using Markdown.

## Packages

- `@rundown/parser` - Markdown workflow parser
- `@rundown/core` - Workflow state management and XState compilation
- `@rundown/cli` - Command-line interface (`rundown`, `rd`)

## Installation

```bash
npm install -g @rundown/cli
```

## Commands

```bash
rundown run <file>       # Run a workflow
rundown pass             # Mark current step as passed (evaluates PASS condition)
rundown fail             # Mark current step as failed (evaluates FAIL condition)
rundown goto <n>         # Jump to specific step number
rundown status           # Show current state
rundown stop             # Abort workflow
rundown complete         # Mark complete
rundown stash            # Pause enforcement
rundown pop              # Resume enforcement
rundown ls               # List active workflows
rundown ls --all         # List available workflow files
rundown check <file>     # Check workflow for errors
```

The `rd` command is an alias for `rundown`.

## State Persistence

State persists in `.claude/rundown/runs/` (execution state) and `.claude/rundown/session.json` (active workflow tracking). Workflow source files are discovered from `.claude/rundown/runbooks/`. All persist across context clears.

## Environment Variables

- `RUNDOWN_LOG=0` - Disable logging (enabled by default)
- `RUNDOWN_LOG_LEVEL=debug|info|warn|error` - Set log verbosity (default: info)

## Development Commands

```bash
npm run build      # Build all packages
npm run test       # Run all tests (Jest)
npm run lint       # Lint all packages
npm run lint:fix   # Auto-fix lint issues
```

## Documentation

- [docs/SPEC.md](docs/SPEC.md) - Rundown specification
