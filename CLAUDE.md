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
rundown stop [message]   # Abort workflow with optional message
rundown complete [message] # Mark complete with optional message
rundown stash            # Pause enforcement
rundown pop              # Resume enforcement
rundown ls               # List active workflows
rundown ls --all         # List available workflow files
rundown check <file>     # Check workflow for errors
rundown echo             # Test helper: echo with configurable result
rundown prune            # Remove stale workflow state files
rundown scenarios <file> # List or show scenarios from runbook
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
 * Parse a workflow document from markdown content.
 *
 * @param markdown - The markdown content to parse
 * @param filename - Source filename for error messages
 * @param options - Parser options
 * @returns Parsed workflow with steps and metadata
 * @throws WorkflowSyntaxError if markdown contains invalid syntax
 *
 * @example
 * ```ts
 * const workflow = parseWorkflowDocument(content, 'my-workflow.md');
 * ```
 */
export function parseWorkflowDocument(
  markdown: string,
  filename?: string,
  options?: ParseOptions
): Workflow { ... }
```

## Documentation

- [docs/SPEC.md](docs/SPEC.md) - Rundown specification
