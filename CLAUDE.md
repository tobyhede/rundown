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
rundown run [file]       # Run a runbook (JSON output by default)
rundown run [file] --text # Output execution events as human-readable text
rundown run [file] --input key=value  # Set template variable (repeatable, omit =value to inherit from env)
rundown run [file] --input-json key=json  # Set variable with JSON value (repeatable)
rundown run [file] --input-file path  # Load variables from YAML file (repeatable)
rundown run [file] --prompted  # Show commands without auto-executing
rundown run [file] --step <stepId>   # Link child to parent substep (inline nested execution)
rundown run [file] --step <stepId> --prompted  # Jump to step after starting (goto)
rundown run [file] --step <stepId> --index <number>  # FOR loop iteration to target
rundown pass             # Mark current step as passed (aliases: yes, ok)
rundown pass --step <stepId>         # Target specific substep
rundown pass --index <number>        # FOR loop iteration (requires --step)
rundown fail             # Mark current step as failed (alias: no)
rundown fail --step <stepId>         # Target specific substep
rundown fail --index <number>        # FOR loop iteration (requires --step)
rundown goto <step>      # Jump to step (e.g., '3', '3.1' for substep)
rundown goto <step> --index <number> # FOR loop iteration to target
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
rundown echo -r pass     # Configure result (pass|fail, repeatable — sequences through results)
rundown prune            # Remove runbook state (default: completed + stopped)
rundown prune --dry-run  # Show what would be removed without deleting
rundown prune --completed # Prune successfully completed runbook state
rundown prune --stopped  # Prune stopped (aborted/failed) runbook state
rundown prune --active   # Prune active runbook state
rundown prune --inactive # Prune inactive (orphaned) runbook state
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
rundown delegate <runbook> --step <id> --input key=value  # With variables (repeatable)
rundown delegate <runbook> --step <id> --input-json key=json  # With JSON variables
rundown delegate <runbook> --step <id> --input-file path  # Load variables from YAML file (repeatable)
rundown delegate --step <id> --index <number>  # FOR loop iteration to target
rundown claim <token>                   # Claim a delegation token and launch child
rundown claim <token> --input key=value   # Claim with variables (repeatable)
rundown claim <token> --input-json key=json  # Claim with JSON variables
rundown claim <token> --input-file path   # Load variables from YAML file (repeatable)
rundown abort <token>                   # Cancel a delegation token (--force for claimed)
rundown collect                         # Aggregate current DELEGATE step and fire transition
rundown collect --step <id>             # Target a specific substep scope
```

The `rd` command is an alias for `rundown`.

### rdpath (Path Assembly Tool)

```bash
rdpath --dir <path>                           # Assemble base path (default subcommand)
rdpath --dir <path> --ctx <id>                # With context scope (.rd-<id>/)
rdpath --dir <path> --file <name>             # With date-prefixed filename
rdpath --dir <path> --ctx <id> --file <name>  # With date-prefixed filename in context
rdpath --dir <path> find <pattern>            # Find files matching glob pattern
rdpath --dir <path> --ctx <id> find <pattern> # Find within context scope
```

### rdx (JSON-to-Markdown CLI)

```bash
rdx <file>                        # Render JSON to Markdown (stdout)
rdx <file> -o, --output <path>    # Write Markdown to file
rdx <file> --check                # Validate only, no rendering
rdx <file> --schema <name>        # Explicit schema for validation
```

Schema validation is automatic when the JSON includes `"$schema": "https://rundown.org/schemas/<name>.schema.json"`. See [docs/RDX.md](docs/RDX.md) for full reference.

## Template Variables

Template variables use Handlebars syntax `{{variableName}}` and are expanded at run time. The full precedence table, built-in variables list, and context-passing semantics live in the specification:

- [docs/SPEC.md §6 Templating](docs/SPEC.md#6-templating) — precedence order, reserved keys, required variables
- [docs/SPEC.md §6.1 Built-in Variables](docs/SPEC.md#61-built-in-variables) — `Date`, `Branch`, `WorkPath`, `RunId`, `ContextId`, `Step`, `Index`, `context.current.*`, plus plugin variables (`CLAUDE_PLUGIN_ROOT`)
- [docs/SPEC.md §7 Context Passing](docs/SPEC.md#7-context-passing-outputs) — OUTPUTS directives and frontmatter `outputs:` / `inputs:` fields

**CLI Example:**
```bash
rundown run deploy.md --input environment=staging --input version=1.2.3
rundown run deploy.md --input-file base.yaml --input-file env.yaml  # Layer multiple files
rundown run deploy.md --input API_KEY                              # Inherit from env
rundown run deploy.md --input-json 'items=["a","b","c"]'          # JSON array value
RD_INPUT_environment=staging rundown run deploy.md                 # Environment bridge
```

**Frontmatter Example:**
```yaml
---
name: my-runbook
inputs:
  environment: development
  port: 3000
  debug: true
required:
  - PlanPath
---
# My Runbook

## 1. Start server
Server running on port {{ port }} in {{ environment }} mode.
Deploy plan at {{ PlanPath }}.
```

The `required` field declares variables the caller must provide. Required variables must not appear in `inputs:` (they have no default). Missing required variables produce a hard error at resolution time. Provide them via `--input`, `--input-file`, config, `RD_INPUT_*` env vars, or delegation inheritance.

**Notes:**
- Variable names must match pattern `/^[a-zA-Z_][a-zA-Z0-9_]*$/`
- Undefined variables are preserved as literal `{{variable}}` text
- Frontmatter inputs support string, number, and boolean values (converted to strings). For arrays, use `--input-json` inline or `.rundown/config.yaml` / `--input-file`. For `file:` data sources, use `.rundown/config.yaml` or `--input-file`
- `--input KEY` (without `=`) inherits the value of environment variable `KEY`

### Data Sources

Variables whose values are arrays or `file:`-prefixed paths become **data sources** for FOR loop iteration. Template variables are expanded with `{{ }}` syntax, while data sources drive `FOR variable IN {{ source }}` iteration:

| Value Type | Template Variable | Data Source | Example |
|------------|-------------------|-------------|---------|
| JSON array (`--input-json`) | Comma-joined | Array DataSource | `--input-json items='["a","b","c"]'` |
| `file:path/to/data.jsonl` | JsonArrayStream ref | File DataSource | `--input items=file:data.jsonl` |
| `file:path/to/data.json` | JsonArray/JsonObject | File DataSource (if array) | `--input items=file:data.json` |
| Array (YAML) | Comma-joined | Array DataSource | `items: [a, b, c]` in config |
| Scalar | String value | Not set | `--input name=value` |

Data sources are referenced in FOR clauses: `FOR item IN {{ items }}`.

**File formats:** Only `.json` and `.jsonl` extensions are supported. `.jsonl` files are parsed as JSON Lines (one JSON value per line). Each line may contain any JSON value (string, number, boolean, null, array, or object). When the loop variable holds a parsed JSON object, dotted field access is supported in templates (e.g., `{{item.name}}`). Using `{{item}}` alone renders the serialized JSON string. `.json` files are eagerly loaded as a `JsonObject` or `JsonArray` value.

**Notes:**
- Arrays can be passed inline via `--input-json` or in `.rundown/config.yaml` and `--input-file` (not in frontmatter `inputs:`). `file:` values are supported in `.rundown/config.yaml` and `--input-file` only
- File paths must stay within the project root (symlinks resolved, traversal blocked)
- `file:` values are routed into the internal variable store as typed values (`JsonArrayStream` for `.jsonl`, `JsonArray`/`JsonObject` for `.json`)

**Note:** The `scenarios` frontmatter field is an internal testing/demo feature, not part of the public Rundown format specification. See [docs/SCENARIOS.md](docs/SCENARIOS.md).

## Schema Output

The `--schema` flag outputs the JSON Schema for a command's JSON output (supported by all commands with JSON output):

```bash
rd status --schema           # Status response schema
rd check --schema            # Check response schema
rd scenario ls --schema      # Scenario list schema
```

This enables programmatic validation of CLI output against the schema.

## State Persistence

State persists in `.rundown/runs/` (execution state) and `.rundown/session.json` (active runbook tracking). Runbook source files are discovered from multiple locations (see [Runbook Discovery](#runbook-discovery)). State files persist across context clears.

<important>
**Principle:** NEVER migrate persisted runbook state between versions.
</important>

**Principle:** Never migrate persisted runbook state between versions. This applies to all data written to `.rundown/runs/`: structured `RunbookState` fields (step, variables, lifecycle, etc.) and the opaque `state.snapshot` blob stored inside `RunbookState`. Neither is exempt. On schema changes, running runbooks should be completed/closed and restarted. The CLI should detect stale state (via schema version or structural guard) and prompt the user to finish or prune — never silently adapt, rewrite, or shim the data.

There is no in-memory migration scenario. In-memory state does not survive process restarts. Any state that reaches `createActor` originates from disk and is subject to the same no-migration rule.

## Runbook Discovery

Runbooks are discovered from multiple sources with the following priority (highest to lowest):

| Source | Location | Description |
|--------|----------|-------------|
| Project | `.rundown/runbooks/` | Project-local runbooks |
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
- `RD_INPUT_<name>=<value>` - Set template variable `<name>` via environment (prefix stripped). E.g., `RD_INPUT_environment=staging` sets `{{environment}}`
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
npm run verify        # Pre-PR: check format, spell, lint, test (MUST run before push)
npm run lint          # Lint all packages (biome + eslint)
npm run check:lint:fast   # Fast lint (biome only)
npm run check:lint:typed  # Typed lint (eslint only)
npm run check:complexity  # Standalone complexity checks (biome + eslint)
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
npm run verify:claude    # Docker: verify CLI+plugin install (local build)
npm run verify:claude:npm  # Docker: verify install from npm registry
npm run test:e2e                              # Docker: E2E plugin workflow test
npm run test:e2e:shell                        # Docker: interactive Claude Code session (test-app fixture)
npm run test:e2e:shell -- ~/path/to/project    # Docker: interactive session with mounted project
npm run test:e2e:shell -- --bash              # Docker: bash shell for debugging
npm run test:e2e:shell -- --no-build          # Docker: skip rebuild (cached image)
npm run test:e2e:build                        # Docker: build E2E test image
```

## Testing Conventions

- **Use `Error.isError()` instead of `instanceof Error`** in tests and production code. `instanceof` fails across ESM realm boundaries (e.g. Jest module sandboxing). Node 24+ provides `Error.isError()` (TC39). Centralized guards `isError()`, `isNodeError()`, `getErrorMessage()` are in `packages/core/src/errors.ts` (and `packages/claude-code-plugin/src/shared/errors.ts`). Keep `instanceof` only for same-realm custom error classes (e.g. `RunbookSyntaxError`, `RundownError`).

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
 * @param basename - Optional filename used to derive runbook name if not in frontmatter
 * @returns ParseResult with runbook AST and structural validation diagnostics
 * @see parseRunbook for simplified parsing returning only steps
 */
export function parseRunbookDocument(
  markdown: string,
  basename?: string,
): ParseResult { ... }
```

## CLI Output Standards

New CLI commands MUST use `OutputEmitter` for consistent output with format-agnostic rendering. Import paths are relative to `packages/cli/src/commands/`:

```typescript
// In packages/cli/src/commands/your-command.ts
import { OutputEmitter } from '../services/output-emitter.js';

const output = new OutputEmitter({ text: options.text });

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

For direct table formatting (no JSON output support), use `formatTable` from `../helpers/table-formatter.js` (also relative to commands/).

Key conventions:
- UPPERCASE headers, 2-space column separators
- Left-align text, right-align numbers
- JSON output by default; `--text` flag for human-readable output

See [docs/RUNDOWN.md](docs/RUNDOWN.md#output-format) for full output formatting standards.

## Internal Command Execution

In WebContainer environments where nested process spawning doesn't work, the CLI intercepts `rd`/`rundown` commands and executes them directly:

- `packages/cli/src/services/internal-commands.ts` - Dispatcher for internal command execution
- `isInternalRdCommand()` - Detects rd/rundown commands
- `executeRdCommandInternal()` - Executes commands without spawning

Currently supported internally: `echo`, `prompt`. Unsupported commands fall back to spawn.

## Documentation

- [docs/SPEC.md](docs/SPEC.md) - Rundown specification (includes §6.1 Built-in Variables and §7 Context Passing / INPUTS / OUTPUTS)
- [docs/FORMAT.md](docs/FORMAT.md) - W3C EBNF grammar for runbook syntax
- [docs/MCP.md](docs/MCP.md) - MCP server reference
- [docs/SECURITY.md](docs/SECURITY.md) - Security policy configuration
- [docs/RUNDOWN.md](docs/RUNDOWN.md) - Rundown internal architecture
- [docs/CLI-OUTPUT-SPEC.md](docs/CLI-OUTPUT-SPEC.md) - CLI output format specification
- [runbooks/README.md](runbooks/README.md) - Runbook authoring patterns
- [docs/SCRIPTING.md](docs/SCRIPTING.md) - Scripting and automation guide
- [docs/AGENT-ORCHESTRATION.md](docs/AGENT-ORCHESTRATION.md) - Subagent delegation, context discovery, and delegation completion
- [docs/PROJECT-INTEGRATION.md](docs/PROJECT-INTEGRATION.md) - Project integration guide
- [docs/DOCKER.md](docs/DOCKER.md) - Docker testing (verification, E2E, plugin smoke tests)
- [docs/SCENARIOS.md](docs/SCENARIOS.md) - Scenarios and test runbook standard
- [docs/RDX.md](docs/RDX.md) - RDX JSON-to-Markdown CLI reference
- [docs/RDPATH.md](docs/RDPATH.md) - rdpath path assembly CLI reference

## Conceptual Model

Three distinct concepts govern step execution. Never conflate them:

| Concept | Domain | Examples |
|---------|--------|----------|
| **RESULT** | Outcome of execution | `pass`, `fail` |
| **HANDLER** | Configured mapping from result to action | `PASS CONTINUE`, `FAIL DEFER` |
| **ACTION** | What to do next | `CONTINUE`, `NEXT`, `BREAK`, `DEFER`, `STOP`, `COMPLETE`, `GOTO` |

A step produces a **result** (pass/fail). The runbook's **handler** for that result determines the **action** to take. These are separate layers — a result is not an action, and a handler is not a result.

## Design Principles

**Type-driven dispatch.** Types drive logic everywhere possible. Use discriminated unions and type narrowing to make invalid states unrepresentable. Guards express domain conditions through typed return values, never raw action-type string checks. If logic branches on a string discriminant, that discriminant should be encoded in a purpose-built type that forces callers to narrow before accessing variant-specific fields. `if` statements checking action types in guards are code smells — missing type structure. See [docs/RUNDOWN.md](docs/RUNDOWN.md#design-principles) for state machine specifics.

**No silent mapping.** Actions like STOP, COMPLETE, BREAK must propagate as themselves. Never silently convert one action type to another (e.g., mapping DEFER to CONTINUE). Each action type has distinct semantics that must be preserved through the entire dispatch chain.

**No synthetic IDs.** Don't create artificial state identifiers (like `~channel` prefixes). Use XState's native event system and state graph structure.
