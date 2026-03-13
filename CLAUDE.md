# CLAUDE.md

Rundown is a format for defining executable runbooks using Markdown.

## Packages

- `@rundown-org/parser` - Markdown runbook parser
- `@rundown-org/core` - Core runbook state management and execution
- `@rundown-org/cli` - Command-line interface (`rundown`, `rd`)
- `@rundown-org/mcp` - MCP server for AI agent integration
- `@rundown-org/claude-code-plugin` - Claude Code plugin for runbook orchestration

## Installation

```bash
npm install -g @rundown-org/cli
```

## Commands

```bash
rundown run [file]       # Run a runbook
rundown run [file] --json # Output execution events as JSON
rundown run [file] --var key=value  # Set template variable (repeatable)
rundown run [file] --var-file path  # Load variables from YAML file
rundown run [file] --prompted  # Show commands without auto-executing
rundown pass             # Mark current step as passed (aliases: yes, ok)
rundown fail             # Mark current step as failed (alias: no)
rundown goto <step>      # Jump to step (e.g., '3', '3.1' for substep)
rundown status           # Show current state
rundown stop [message]   # Abort runbook with optional message
rundown complete [message] # Force early completion (runbooks auto-complete on final step)
rundown stash            # Pause enforcement (stash active runbook)
rundown pop              # Resume enforcement (restore stashed runbook)
rundown ls               # List active runbooks
rundown ls --all         # List available runbook files
rundown ls --all --tags <tags>  # Filter by comma-separated tags
rundown check <file>     # Check runbook for errors
rundown resolve <file>   # Resolve and validate variables and data sources
rundown echo             # Test helper: echo with configurable result
rundown prune            # Remove runbook state (default: completed)
rundown prune --dry-run  # Show what would be removed without deleting
rundown prune --completed # Prune completed runbook state
rundown prune --active   # Prune active runbook state
rundown prune --inactive # Prune inactive runbook state
rundown prune --all      # Prune all runbook state
rundown scenario ls <file>           # List scenarios in a runbook
rundown scenario show <file> <name>  # Show scenario details
rundown scenario run <file> <name>   # Run a scenario
rundown scenario run <file> <name> -q, --quiet  # Run scenario (suppress output)
rundown scenario-suite ls <suite-file>           # List cases in a scenario suite
rundown scenario-suite show <suite-file> <case>  # Show case details
rundown scenario-suite run <suite-file> [case]   # Run a case (or all with --all)
rundown prompt <content> # Output content in markdown fences
rundown delegate                        # Infer substep and runbook from state
rundown delegate --step <id>            # Infer runbook from substep reference
rundown delegate <runbook> --step <id>  # Explicit delegation
rundown delegate <runbook> --step <id> --var key=value  # With variables
rundown claim <token>                   # Claim a delegation token and launch child
rundown claim <token> --var key=value   # Claim with variables
rundown abort <token>                   # Cancel a delegation token (--force for claimed)
```

The `rd` command is an alias for `rundown`.

## Template Variables

Template variables use Handlebars syntax `{{variableName}}` and are expanded at run time.

**Variable Sources (Precedence: High to Low):**
1. `--var key=value` flags (highest priority, repeatable)
2. `--var-file path` contents (YAML format)
3. `.rundown/config.yaml` (auto-discovered from cwd upward, stops at git root)
4. Frontmatter `vars:` field
5. Inherited delegation variables (parent context in delegation tree)
6. Built-in defaults (lowest priority)

**Built-in Variables:**
| Variable | Example Value | Description |
|----------|---------------|-------------|
| `Date` | `2026-02-04` | Current date (YYYY-MM-DD) |
| `DateTime` | `2026-02-04T10:30:00.000Z` | Full ISO 8601 timestamp |
| `Year` | `2026` | Current year |
| `Month` | `02` | Current month (01-12) |
| `Day` | `04` | Current day (01-31) |
| `WorkPath` | `.work` | Default artifact directory |
| `RunId` | `4a7f0c3e` | Unique-per-execution identifier |
| `ContextId` | `a3b8c1d2` | Shared identity across delegation tree |
| `Step` | `3.1` | Current qualified step identifier |
| `Index` | `3` | Current loop iteration number (inside FOR) |
| `context.current.step` | `3` | Current step number |
| `context.current.substep` | `1` | Current substep number (when in substep) |
| `context.current.index` | `3` | Current loop iteration (inside FOR) |
| `context.current.at` | `3.1[3]` | Full execution position |

Built-in variables use PascalCase. Lowercase aliases `step` and `index` are also available. The date/time variables (`Date`, `DateTime`, `Year`, `Month`, `Day`), `WorkPath`, `RunId`, and `ContextId` are static run-time variables set once per execution and can be overridden via `--var`. `RunId` is a fresh 8-character hexadecimal identifier generated per execution; each child in a delegation tree gets its own RunId. `ContextId` is a fresh 8-character hexadecimal identifier generated per execution; children in a delegation tree inherit the parent's ContextId via `--var`, providing a shared identity across the tree. It can be overridden via `--var` to use a meaningful name (e.g., `--var ContextId=sprint-42`). The `Step` variable (and `Index` during FOR loops), `context.current.*` variables, and their lowercase aliases are dynamic per-step variables that reflect the current execution position and cannot be overridden via `--var`. The variable name `context` is reserved and cannot be used as a user variable name.

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

The `--schema` flag outputs the JSON Schema for a command's `--json` output (supported by all commands with `--json` output):

```bash
rd status --schema           # Status response schema
rd check --schema            # Check response schema
rd scenario ls --schema      # Scenario list schema
```

This enables programmatic validation of CLI output against the schema.

## State Persistence

State persists in `.claude/rundown/runs/` (execution state) and `.claude/rundown/session.json` (active runbook tracking). Runbook source files are discovered from multiple locations (see [Runbook Discovery](#runbook-discovery)). State files persist across context clears.

**Principle:** Never migrate persisted runbook state between versions. On schema changes, running runbooks should be completed/closed and restarted. The CLI should detect stale state and prompt the user rather than attempting silent migration.

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
rundown run [file] --allow-run git,npm    # Allow specific commands
rundown run [file] --allow-read /path     # Allow reading specific paths
rundown run [file] --allow-write /path    # Allow writing to specific paths
rundown run [file] --allow-env VAR        # Allow specific environment variables
rundown run [file] --allow-all            # Bypass policy (trust mode)
rundown run [file] --deny-all             # Block all commands
rundown run [file] -y, --yes              # Skip confirmation prompts
rundown run [file] --non-interactive      # CI mode (auto-deny)
rundown run [file] --no-color             # Disable colored output
rundown run [file] --policy ./policy.yaml # Custom policy file
rundown run [file] --sandbox              # Enable OS-level sandbox (default)
rundown run [file] --no-sandbox           # Disable sandbox (trust mode)
rundown run [file] --sandbox-strict       # Fail if sandbox unavailable
rundown run [file] --trust-js-policy      # Trust executable JS policy configs
```

## Policy Configuration

Policy files are auto-discovered from: `.rundownrc`, `.rundownrc.json`, `.rundownrc.yaml`, `.rundownrc.yml`, `package.json` (rundown field). JavaScript config files (`.js`, `.cjs`, `.mjs`) are not auto-discovered — they require explicit `--policy <path>` with `--trust-js-policy`.

See [docs/SECURITY.md](docs/SECURITY.md) for full security policy documentation.

## Environment Variables

- `RUNDOWN_LOG=0` - Disable logging (enabled by default)
- `RUNDOWN_LOG_LEVEL=debug|info|warn|error` - Set log verbosity (default: info)
- `NO_COLOR=1` - Disable colored output (standard convention)
- `FORCE_COLOR=1` - Force colored output even in non-TTY environments

## CI / Workflow Conventions

- **SHA-pinned actions**: GitHub Actions are pinned by commit SHA with a version comment (e.g., `actions/checkout@<sha> # v6`). This is intentional for supply-chain security. Do not replace SHAs with version tags.

## Development Commands

```bash
npm run build         # Build all packages
npm test              # Fast: unit tests, all packages in parallel
npm run test:unit     # Same as npm test
npm run test:integration  # Integration tests in parallel
npm run test:all      # Full suite: unit → integration → property → perf
npm run test:coverage # Test coverage across all packages
npm run verify        # Pre-PR: format, spell, lint, test (MUST run before push)
npm run lint          # Lint all packages (biome + eslint)
npm run check:lint:fast   # Fast lint (biome only)
npm run check:lint:typed  # Typed lint (eslint only)
npm run fix:lint      # Auto-fix lint issues
npm run fix:lint:fast # Auto-fix biome lint issues
npm run fix:lint:typed # Auto-fix eslint lint issues
npm run format        # Format all packages
npm run check:format  # Check formatting
npm run check:spell   # Check spelling across all packages
npm run test:mutate   # Mutation testing (all packages, sequential)
npm run test:mutate:parser  # Mutation testing for parser only
npm run test:mutate:core    # Mutation testing for core only
npm run test:mutate:cli     # Mutation testing for cli only
npm run test:mutate:plugin  # Mutation testing for plugin only
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
- [runbooks/README.md](runbooks/README.md) - Runbook authoring patterns
- [docs/SCRIPTING.md](docs/SCRIPTING.md) - Scripting and automation guide
- [docs/AGENT-ORCHESTRATION.md](docs/AGENT-ORCHESTRATION.md) - Agent orchestration models and patterns
- [docs/PROJECT-INTEGRATION.md](docs/PROJECT-INTEGRATION.md) - Project integration guide
- [docs/DOCKER.md](docs/DOCKER.md) - Docker verification pipeline
- [docs/SCENARIOS.md](docs/SCENARIOS.md) - Scenarios and test runbook standard

## Conceptual Model

Three distinct concepts govern step execution. Never conflate them:

| Concept | Domain | Examples |
|---------|--------|----------|
| **RESULT** | Outcome of execution | `pass`, `fail` |
| **HANDLER** | Configured mapping from result to action | `PASS CONTINUE`, `FAIL DEFER` |
| **ACTION** | What to do next | `CONTINUE`, `NEXT`, `BREAK`, `DEFER`, `STOP`, `COMPLETE` |

A step produces a **result** (pass/fail). The runbook's **handler** for that result determines the **action** to take. These are separate layers — a result is not an action, and a handler is not a result.

## Design Principles

**Type-driven dispatch.** Types drive logic everywhere possible. Use discriminated unions and type narrowing to make invalid states unrepresentable. Guards express domain conditions through typed return values, never raw action-type string checks. If logic branches on a string discriminant, that discriminant should be encoded in a purpose-built type that forces callers to narrow before accessing variant-specific fields. `if` statements checking action types in guards are code smells — missing type structure. See [docs/RUNDOWN.md](docs/RUNDOWN.md#design-principles) for state machine specifics.

**No silent mapping.** Actions like STOP, COMPLETE, BREAK must propagate as themselves. Never silently convert one action type to another (e.g., mapping DEFER to CONTINUE). Each action type has distinct semantics that must be preserved through the entire dispatch chain.

**No synthetic IDs.** Don't create artificial state identifiers (like `~channel` prefixes). Use XState's native event system and state graph structure.
