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
rundown pass             # Mark current step as passed (evaluates PASS condition)
rundown fail             # Mark current step as failed (evaluates FAIL condition)
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
rundown scenario <cmd>   # List, show, or run scenarios
```

The `rd` command is an alias for `rundown`.

## State Persistence

State persists in `.claude/rundown/runs/` (execution state) and `.claude/rundown/session.json` (active runbook tracking). Runbook source files are discovered from `.claude/rundown/runbooks/`. All persist across context clears.

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

**Example:**
```typescript
/**
 * Parse a runbook document from markdown content.
 *
 * @param markdown - The markdown content to parse
 * @param filename - Source filename for error messages
 * @param options - Parser options
 * @returns Parsed runbook with steps and metadata
 * @throws RunbookSyntaxError if markdown contains invalid syntax
 *
 * @example
 * ```ts
 * const runbook = parseRunbookDocument(content, 'my-runbook.md');
 * ```
 */
export function parseRunbookDocument(
  markdown: string,
  filename?: string,
  options?: ParseOptions
): Runbook { ... }
```

## CLI Output Standards

New CLI commands MUST use the shared table formatter for consistent output:

```typescript
import { printTable } from '../helpers/table-formatter.js';

printTable(rows, [
  { header: 'NAME', key: 'name' },
  { header: 'STATUS', key: 'status' },
]);
```

Key conventions:
- UPPERCASE headers, 2-space column separators
- Left-align text, right-align numbers
- `--json` flag for machine-readable output

See [docs/RUNDOWN.md](docs/RUNDOWN.md#output-format) for full output formatting standards.

## Documentation

- [docs/SPEC.md](docs/SPEC.md) - Rundown specification
