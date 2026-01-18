# CLAUDE.md

Rundown is a format for defining executable runbooks using Markdown.

## Packages

- `@rundown/parser` - Markdown runbook parser
- `@rundown/core` - Runbook state management and XState compilation
- `@rundown/cli` - Command-line interface (`rundown`, `rd`)

## Installation

```bash
npm install -g @rundown/cli
```

## Commands

```bash
rundown run <file>       # Run a runbook
rundown pass             # Mark current step as passed (aliases: yes, ok)
rundown fail             # Mark current step as failed (alias: no)
rundown goto <n>         # Jump to specific step number
rundown status           # Show current state
rundown stop [message]   # Abort runbook with optional message
rundown complete [message] # Mark complete with optional message
rundown stash            # Pause enforcement (stash active runbook)
rundown pop              # Resume enforcement (restore stashed runbook)
rundown ls               # List active runbooks
rundown ls --all         # List available runbook files
rundown check <file>     # Check runbook for errors
rundown echo             # Test helper: echo with configurable result
rundown prune            # Remove stale runbook state files
rundown scenario ls <file>           # List scenarios in a runbook
rundown scenario show <file> <name>  # Show scenario details
rundown scenario run <file> <name>   # Run a scenario
rundown prompt <content> # Output content in markdown fences
```

The `rd` command is an alias for `rundown`.

## State Persistence

State persists in `.claude/rundown/runs/` (execution state) and `.claude/rundown/session.json` (active runbook tracking). Runbook source files are discovered from `.claude/rundown/runbooks/`. All persist across context clears.

## Policy Options

```bash
rundown run <file> --allow-run git,npm    # Allow specific commands
rundown run <file> --allow-all            # Bypass policy (trust mode)
rundown run <file> --deny-all             # Block all commands
rundown run <file> -y                     # Auto-approve prompts
rundown run <file> --non-interactive      # CI mode (auto-deny)
rundown run <file> --policy ./policy.yaml # Custom policy file
```

## Policy Configuration

Policy files are discovered from: `.rundownrc`, `.rundownrc.json`, `.rundownrc.yaml`, `.rundownrc.yml`, `rundown.config.js`, `rundown.config.cjs`, `rundown.config.mjs`, `package.json` (rundown field).

See [docs/SECURITY.md](docs/SECURITY.md) for full security policy documentation.

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

## TSDoc Standards

All exported symbols must have TSDoc documentation following these requirements:

| Element | Required |
|---------|----------|
| Exported functions | Description, `@param` for all parameters, `@returns` if non-void, `@throws` if exceptions possible |
| Exported interfaces/types | Description, property comments for non-obvious fields |
| Exported classes | Class description, constructor and public method documentation |
| Type guards | Description, `@param`, `@returns` with type predicate explanation |
| Deprecated items | `@deprecated` with migration guidance |

**Example** (simplified; see actual source for full documentation):
```typescript
/**
 * Parse entire runbook document including metadata.
 *
 * Parses a complete Rundown runbook markdown document, extracting:
 * - YAML frontmatter (name, version, author, tags)
 * - H1 title and preamble description
 * - H2 step definitions with commands, prompts, and transitions
 *
 * @param markdown - The raw markdown content to parse
 * @param filename - Optional filename used to derive runbook name if not in frontmatter
 * @param options - Optional parsing options (e.g., skipValidation)
 * @returns Complete Runbook object with metadata and steps
 * @throws {RunbookSyntaxError} When the markdown contains invalid syntax
 * @see parseRunbook for simplified parsing returning only steps
 */
export function parseRunbookDocument(
  markdown: string,
  filename?: string,
  options?: ParseOptions
): Runbook { ... }
```

## CLI Output Standards

New CLI commands MUST use `OutputManager` for consistent output with automatic JSON/text mode switching:

```typescript
import { OutputManager } from '../services/output-manager.js';

const output = new OutputManager({ json: options.json });

output.list(items, [
  { header: 'NAME', key: 'name' },
  { header: 'STATUS', key: 'status' },
], {
  emptyMessage: 'No items found.',
  jsonMapper: (item) => ({ name: item.name, status: item.status }),
});
```

For direct table formatting without JSON support, use `formatTable` from `../helpers/table-formatter.js`.

Key conventions:
- UPPERCASE headers, 2-space column separators
- Left-align text, right-align numbers
- `--json` flag for machine-readable output

See [docs/RUNDOWN.md](docs/RUNDOWN.md#output-format) for full output formatting standards.

## Internal Command Execution

In WebContainer environments where nested process spawning doesn't work, the CLI intercepts `rd`/`rundown` commands and executes them directly:

- `packages/cli/src/services/internal-commands.ts` - Dispatcher for internal command execution
- `isInternalRdCommand()` - Detects rd/rundown commands
- `executeRdCommandInternal()` - Executes commands without spawning

Currently supported internally: `echo`. Unsupported commands fall back to spawn.

## Documentation

- [docs/SPEC.md](docs/SPEC.md) - Rundown specification
