# CLAUDE.md

Rundown is a format for defining executable runbooks using Markdown.

## Packages

- `@rundown-org/parser` - Markdown runbook parser
- `@rundown-org/core` - Runbook state management and XState compilation
- `@rundown-org/cli` - Command-line interface (`rundown`, `rd`)
- `@rundown-org/mcp` - MCP server for AI agent integration
- `@rundown-org/claude-code-plugin` - Claude Code plugin for runbook orchestration

## Installation

```bash
npm install -g @rundown-org/cli
```

## Commands

```bash
rundown run <file>       # Run a runbook
rundown run <file> --json # Output execution events as JSON
rundown run <file> --var key=value  # Set template variable (repeatable)
rundown run <file> --var-file path  # Load variables from YAML file
rundown pass             # Mark current step as passed (aliases: yes, ok)
rundown fail             # Mark current step as failed (alias: no)
rundown goto <n>         # Jump to specific step number
rundown status           # Show current state
rundown stop [message]   # Abort runbook with optional message
rundown complete [message] # Force early completion (runbooks auto-complete on final step)
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

## Template Variables

Template variables use Handlebars syntax `{{variableName}}` and are expanded at run time.

**Variable Sources (Precedence: High to Low):**
1. `--var key=value` flags (highest priority, repeatable)
2. `--var-file path` contents (YAML format)
3. `.rundown/config.yaml` (auto-discovered from cwd upward, stops at git root)
4. Frontmatter `vars:` field
5. Built-in defaults (lowest priority)

**Built-in Variables:**
| Variable | Example Value | Description |
|----------|---------------|-------------|
| `Date` | `2026-02-04` | Current date (YYYY-MM-DD) |
| `DateTime` | `2026-02-04T10:30:00.000Z` | Full ISO 8601 timestamp |
| `Year` | `2026` | Current year |
| `Month` | `02` | Current month (01-12) |
| `Day` | `04` | Current day (01-31) |
| `WorkPath` | `.work` | Default artifact directory |
| `Step` | `3.1` | Current qualified step identifier |
| `Index` | `3` | Current loop iteration number (inside FOR) |

Built-in variables use PascalCase. The date/time variables (`Date`, `DateTime`, `Year`, `Month`, `Day`) and `WorkPath` are static run-time variables set once per execution and can be overridden via `--var`. The `Step` variable (and `Index` during FOR loops) are dynamic per-step variables that reflect the current execution position and cannot be overridden via `--var`.

**CLI Example:**
```bash
rundown run deploy.md --var environment=staging --var version=1.2.3
```

**Frontmatter Example:**
```yaml
---
name: my-runbook
vars:
  environment: development
  port: 3000
  debug: true
---
# My Runbook

## 1. Start server
Server running on port {{ port }} in {{ environment }} mode.
```

**Notes:**
- Variable names must match pattern `/^[a-zA-Z_][a-zA-Z0-9_]*$/`
- Undefined variables are preserved as literal `{{variable}}` text
- Frontmatter vars support string, number, and boolean values (converted to strings). For arrays and file data sources, use `.rundown/config.yaml` or `--var-file`

### Data Sources

Variables whose values are arrays or `file:`-prefixed paths become **data sources** for FOR loop iteration. Template variables are expanded with `{{ }}` syntax, while data sources drive `FOR variable IN {{ source }}` iteration:

| Value Type | Template Variable | Data Source | Example |
|------------|-------------------|-------------|---------|
| `file:path/to/data.txt` | Not set | File DataSource | `--var items=file:data.txt` |
| Array (YAML) | Comma-joined | Array DataSource | `items: [a, b, c]` in config |
| Multiline string | Raw string | Array DataSource (split on newlines) | YAML block scalar |
| Scalar | String value | Not set | `--var name=value` |

Data sources are referenced in FOR clauses: `FOR item IN {{ items }}`.

**File formats:** `.jsonl` files are parsed as JSON Lines (one JSON value per line). Each line may contain any JSON value (string, number, boolean, null, array, or object). When the loop variable holds a parsed JSON object, dotted field access is supported in templates (e.g., `{{item.name}}`). Using `{{item}}` alone renders the serialized JSON string. All other extensions (e.g., `.txt`) use plain text (one value per non-empty line). Users who need raw line strings from a `.jsonl` file should rename it to a `.txt` extension.

**Notes:**
- Arrays and `file:` values are supported in `.rundown/config.yaml` and `--var-file`, not in frontmatter `vars:`
- File paths must stay within the project root (symlinks resolved, traversal blocked)
- `file:` values are routed to sources only — they do NOT appear as template variables

## Schema Output

The `--schema` flag outputs the JSON Schema for any command's `--json` output:

```bash
rd status --schema           # Status response schema
rd check --schema            # Check response schema
rd scenario ls --schema      # Scenario list schema
```

This enables programmatic validation of CLI output against the schema.

## State Persistence

State persists in `.claude/rundown/runs/` (execution state) and `.claude/rundown/session.json` (active runbook tracking). Runbook source files are discovered from multiple locations (see [Runbook Discovery](#runbook-discovery)). State files persist across context clears.

## Runbook Discovery

Runbooks are discovered from multiple sources with the following priority (highest to lowest):

| Source | Location | Description |
|--------|----------|-------------|
| Project | `.claude/rundown/runbooks/` | Project-local runbooks |
| Plugin | `$CLAUDE_PLUGIN_ROOT/runbooks/` | Plugin-provided runbooks |
| Bundled | CLI package `dist/runbooks/` | Bundled pattern runbooks |

Directories are scanned recursively, so subdirectory structures like `planning/write-plan.runbook.md` are supported.

### Namespace Syntax

Use `namespace:name` syntax for explicit source targeting:

| Syntax | Resolution |
|--------|------------|
| `write-plan` | Priority chain: project → plugin → bundled |
| `rundown:write-plan` | Explicit: from plugin only |

**Examples:**

```bash
rd run write-plan              # Resolves via priority chain
rd run rundown:write-plan      # Explicit: from plugin
rd run rundown:nonexistent     # Error: not found in rundown namespace
```

The `rundown` namespace maps to the plugin source (`@rundown-org/claude-code-plugin`).

### Listing Runbooks

```bash
rd ls --all                    # List all discoverable runbooks with source
```

Output shows NAME, SOURCE, DESCRIPTION, and TAGS columns. The SOURCE column indicates where each runbook was found (project, plugin, or bundled).

## Policy Options

These options are registered at the program level and can be used with any subcommand:

```bash
rundown run <file> --allow-run git,npm    # Allow specific commands
rundown run <file> --allow-read /path     # Allow reading specific paths
rundown run <file> --allow-write /path    # Allow writing to specific paths
rundown run <file> --allow-env VAR        # Allow specific environment variables
rundown run <file> --allow-all            # Bypass policy (trust mode)
rundown run <file> --deny-all             # Block all commands
rundown run <file> -y                     # Auto-approve prompts
rundown run <file> --non-interactive      # CI mode (auto-deny)
rundown run <file> --policy ./policy.yaml # Custom policy file
rundown run <file> --sandbox              # Enable OS-level sandbox (default)
rundown run <file> --no-sandbox           # Disable sandbox (trust mode)
rundown run <file> --sandbox-strict       # Fail if sandbox unavailable
```

## Policy Configuration

Policy files are discovered from: `.rundownrc`, `.rundownrc.json`, `.rundownrc.yaml`, `.rundownrc.yml`, `rundown.config.js`, `rundown.config.cjs`, `rundown.config.mjs`, `package.json` (rundown field).

See [docs/SECURITY.md](docs/SECURITY.md) for full security policy documentation.

## Environment Variables

- `RUNDOWN_LOG=0` - Disable logging (enabled by default)
- `RUNDOWN_LOG_LEVEL=debug|info|warn|error` - Set log verbosity (default: info)

## Development Commands

```bash
npm run build         # Build all packages
npm test              # Fast: unit tests, all packages in parallel
npm run test:unit     # Same as npm test
npm run test:integration  # Integration tests in parallel
npm run test:all      # Full suite: unit → integration → property → perf
npm run lint          # Lint all packages
npm run lint:fix      # Auto-fix lint issues
npm run format        # Format all packages
npm run format:check  # Check formatting
npm run spellcheck    # Check spelling across all packages
npm run test:mutate   # Mutation testing (all packages, sequential)
npm run test:mutate:parser  # Mutation testing for parser only
npm run test:property # Property-based tests
npm run test:perf     # Performance benchmarks
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

New CLI commands MUST use `OutputEmitter` for consistent output with format-agnostic rendering. Import paths are relative to `packages/cli/src/commands/`:

```typescript
// In packages/cli/src/commands/your-command.ts
import { OutputEmitter } from '../services/output-emitter.js';

const output = new OutputEmitter({ json: options.json });

output.list(items, [
  { header: 'NAME', key: 'name' },
  { header: 'STATUS', key: 'status' },
], {
  emptyMessage: 'No items found.',
  jsonMapper: (item) => ({ name: item.name, status: item.status }),
});

output.detail(data, 'status');
output.action({ action, from, result, at });
output.flush();
```

For direct table formatting (no `--json` flag support), use `formatTable` from `../helpers/table-formatter.js` (also relative to commands/).

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

Currently supported internally: `echo`, `prompt`. Unsupported commands fall back to spawn.

## Documentation

- [docs/SPEC.md](docs/SPEC.md) - Rundown specification
- [docs/FORMAT.md](docs/FORMAT.md) - Formal BNF-style grammar
- [docs/MCP.md](docs/MCP.md) - MCP server reference
- [docs/SECURITY.md](docs/SECURITY.md) - Security policy configuration
- [docs/RUNDOWN.md](docs/RUNDOWN.md) - Rundown internal architecture
- [docs/CLI-OUTPUT-SPEC.md](docs/CLI-OUTPUT-SPEC.md) - CLI output format specification
- [docs/PATTERNS.md](docs/PATTERNS.md) - Runbook authoring patterns
- [docs/SCRIPTING.md](docs/SCRIPTING.md) - Scripting and automation guide
- [docs/AGENT-ORCHESTRATION.md](docs/AGENT-ORCHESTRATION.md) - Agent orchestration models and patterns
- [docs/PROJECT-INTEGRATION.md](docs/PROJECT-INTEGRATION.md) - Project integration guide
- [docs/DOCKER.md](docs/DOCKER.md) - Docker verification pipeline
