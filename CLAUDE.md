# CLAUDE.md

Rundown is a format for defining executable runbooks using Markdown.

## Packages

- `@rundown-org/parser` - Markdown runbook parser
- `@rundown-org/core` - Core runbook state management and execution
- `@rundown-org/cli` - Command-line interface (`rundown`, `rd`)
- `@rundown-org/mcp` - MCP server for AI agent integration
- `@rundown-org/claude-code-plugin` - Claude Code plugin for runbook orchestration

## Architectural Principles

These principles are foundational. They take precedence over local convenience and are not negotiable on a per-PR basis.

**State machine drives Rundown logic.** All runbook behaviour — step transitions, result aggregation, action dispatch, lifecycle — lives in the XState state machine in `@rundown-org/core`. Other packages MUST invoke the state machine; they MUST NOT re-implement, replicate, or work around its logic. If a desired behaviour isn't expressible in the state machine today, extend the state machine — don't add a shadow implementation elsewhere.

**The CLI is a thin wrapper.** `@rundown-org/cli` exposes the core state machine to agents and humans. Its job is to invoke state transitions and observe their output (events, diagnostics, exit codes). Runbook logic does not live in the CLI. New CLI commands must dispatch into existing core APIs; they do not introduce parallel execution paths, hidden state, or transition rules of their own. The same constraint applies to `@rundown-org/mcp` and `@rundown-org/claude-code-plugin` — they are alternate front ends to the same core.

**Core values, in priority order.** When trade-offs arise, resolve them in this order:

1. **Correctness** — the behaviour matches the spec and the runbook author's intent.
2. **Type safety** — invalid states are unrepresentable; types drive dispatch (see [Design Principles](#design-principles)).
3. **Clean architecture** — small, self-contained modules with clear seams between packages and within packages.
4. **Test coverage** — every behaviour-bearing change is pinned by tests at the right layer (unit, integration, property, mutation).

**Correctness over pragmatism.** Prefer making the work correct over shipping a "pragmatic" shortcut that compromises the values above. A workaround that papers over a state-machine gap, an `any` that hides a typing bug, a skipped test that masks a regression, or a one-off branch in the CLI that should have been a core capability — all are net-negative regardless of the time they save in the short term. When in doubt, raise the design question rather than patching around it.

### Side-effect categorisation

When a side effect needs to happen during runbook execution, classify it into one of three categories before deciding where the code lives. The category determines the architectural pattern.

| Category | Description | Pattern | Examples |
|----------|-------------|---------|----------|
| **A** | Genuinely CLI. Inherently external to the runbook program. | Stays in CLI. CLI sends a typed event into the machine if state must update. | stdin reads, terminal rendering, child-process `spawn` syscall, env-var reads, exit-code-to-process mapping |
| **B** | Machine-owned. Logic is part of the runbook program. No external dependency. | Machine invokes a `fromPromise` actor from core. Pure filesystem or pure computation. | OUTPUTS capture, ARTIFACTS resolution, FOR iteration advancement, frontmatter `outputs:` storage |
| **C** | Machine-owned with DI callable. Logic is part of the runbook program, but execution requires an external service. | Machine invokes an actor parameterised by a callable supplied at machine-construction time. The callable is the DI seam. | Command execution (policy + spawn), helper invocation (helper registry) |

Category B and C actors are placed under `packages/core/src/runbook/actors/` (the directory is established by the first migration that needs it). Each actor is a `fromPromise`-shaped function in its own file, takes a typed `input`, returns a typed `output`, and does not know about the runbook state manager, the actor service, or the CLI emitter. See [docs/internal/architecture.md § Per-step substate pattern](docs/internal/architecture.md#per-step-substate-pattern) for how the machine wires these actors into the per-step state graph.

A side effect that lives in the CLI but classifies as B or C is architectural debt. The fix is to move it, not to rationalise its location.

### Concurrent write synchronization

When multiple CLI processes may mutate the same file (e.g., `.rundown/session.json`, run state, artifact manifest), use **file-based exclusive locks** with process-aware stale lock reclamation:

**Pattern:** Use `acquireFileLock` / `releaseFileLock` from `packages/core/src/runbook/file-lock.ts`.

- **Lock mechanism:** Atomic file creation (`fs.open(..., 'wx')`) on `.rundown/locks/<name>.lock`
- **Stale detection:** Kill signal check (`kill(pid, 0)`) — never age-based expiration
- **Retry:** Jittered backoff (50–100ms) bounded to 5 seconds
- **Release:** Idempotent unlink; safe to call multiple times

**Examples:** `SessionLock` (`packages/core/src/runbook/session-lock.ts` line 122-129), `DelegationLock` (`packages/core/src/runbook/delegation-lock.ts` line 38-87), and fixture tests (`packages/core/__tests__/runbook/session-lock.test.ts`).

**For manifest writes:** Wrap `findEquivalentManifestRow` + append in a lock (e.g., `sessionLockPath(cwd)` if manifest is per-project, or derive a manifest-specific lock path from `manifestPath(cwd)` + `.lock`).

### Actor dependencies

Machine-invoked Category B and C actors receive their inputs from two sources: **compile-time-bound dependencies** (process state, service references, parser-derived data, DI'd callables) flow through the per-state `invoke.input` builder closure constructed inside `compileRunbookToMachine`; **event-time-bound dependencies** (anything that varies per snapshot or per event) are read from `context` inside the `invoke.input` factory at fire time. The corollary is stricter than splitting the wiring: **persisted context contains only data; runtime references flow through invoke-input closures.** Function references cannot be serialised, process-runtime values like `cwd` may differ between the writer and reader of a snapshot, and service instance references go stale across process boundaries — routing each dependency through the right boundary is what prevents these failures by construction. See [docs/internal/architecture.md § Actor input wiring](docs/internal/architecture.md#actor-input-wiring) for the implementation pattern and the canonical worked example.

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
rundown delegate --retry <token>                         # Retry delegation by token
rundown delegate --retry --step <id>                     # Retry delegation on substep
rundown delegate --retry --step <id> --index <n>         # Retry delegation in FOR iteration
rundown delegate --retry                                 # Retry inferred from active substep
rundown delegate --retry --step <id> --var key=value     # Retry with var overrides
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

Schema validation is automatic when the JSON includes `"$schema": "https://rundown.org/schemas/<name>.schema.json"`. See [docs/reference/rdx.md](docs/reference/rdx.md) for full reference.

## Template Variables

Template variables use Handlebars syntax `{{variableName}}` and are expanded at run time. The full precedence table, built-in variables list, and context-passing semantics live in the specification:

- [docs/spec/language.md §6 Templating](docs/spec/language.md#6-templating) — precedence order, reserved keys, required variables
- [docs/reference/runtime.md Built-in Variables](docs/reference/runtime.md#built-in-variables) — `Date`, `Branch`, `WorkPath`, `RunId`, `ContextId`, `Step`, `Index`, `context.current.*`, plus plugin variables (`CLAUDE_PLUGIN_ROOT`)
- [docs/spec/language.md §7 Context Passing](docs/spec/language.md#7-context-passing-outputs) — OUTPUTS directives and frontmatter `outputs:` / `inputs:` fields

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
  - environment
  - port
  - debug
  - PlanPath
required:
  - PlanPath
---
# My Runbook

## 1. Start server
Server running on port {{ port }} in {{ environment }} mode.
Deploy plan at {{ PlanPath }}.
```

The `inputs` field is a list of names — declarations only, with no values. The `required` field declares which of those variables the caller must provide; names listed in `required` must also appear in `inputs`. Missing required variables produce a hard error at resolution time. Provide values via `--input`, `--input-file`, config, `RD_INPUT_*` env vars, or delegation inheritance.

**Notes:**
- Variable names must match pattern `/^[a-zA-Z_][a-zA-Z0-9_]*$/`
- Undefined variables are preserved as literal `{{variable}}` text
- Frontmatter `inputs:` declares names only — values come from `--input`, `--input-file`, `RD_INPUT_*` env vars, `.rundown/config.yaml`, or delegation inheritance. Use `--input-json`, `.rundown/config.yaml`, or `--input-file` for arrays and `file:` data sources
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
- Arrays can be passed via `--input-json` (inline), `.rundown/config.yaml`, or `--input-file`. `file:` values are supported in `.rundown/config.yaml` and `--input-file` only. Frontmatter `inputs:` declares names only and does not carry values
- File paths must stay within the project root (symlinks resolved, traversal blocked)
- `file:` values are routed into the internal variable store as typed values (`JsonArrayStream` for `.jsonl`, `JsonArray`/`JsonObject` for `.json`)

**Note:** The `scenarios` frontmatter field is an internal testing/demo feature, not part of the public Rundown format specification. See [docs/internal/scenarios.md](docs/internal/scenarios.md).

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

Rundown has no released compatibility contract for persisted runbook state. Breaking active runs is acceptable and preferred over compatibility code for consumers that do not exist. When a state shape, XState state ID, snapshot context, variable layout, or run/session schema changes, update the current model and reject old persisted state. Do not add runtime migrations, fallback parsers, legacy field hydration, compatibility shims, warning-only adapters, or branches that preserve older behavior. The recovery path is always explicit user action: finish, stop, prune, or restart from the source runbook.

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
rundown run [file] --trust-js-policy      # Trust executable JS policy configs and config-declared helpers
```

## Policy Configuration

Policy files are auto-discovered from: `.rundownrc`, `.rundownrc.json`, `.rundownrc.yaml`, `.rundownrc.yml`, `package.json` (rundown field). JavaScript config files (`.js`, `.cjs`, `.mjs`) are not auto-discovered — they require explicit `--policy <path>` with `--trust-js-policy`. Helper modules declared by policy config are skipped unless `--trust-js-policy` is set; `--helpers` remains an explicit CLI opt-in.

See [docs/reference/security.md](docs/reference/security.md) for full security policy documentation.

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

- **Use `isError()` / `isNodeError()` / `getErrorMessage()` from `@rundown-org/core`** (or `packages/claude-code-plugin/src/shared/errors.ts` inside the plugin) — never call `Error.isError()` directly. The helpers feature-detect native `Error.isError` (TC39 Stage 4, Node 24+) and fall back to `instanceof Error` so the codebase runs on hosts that ship older Node — notably WebContainer's bundled Node 22.x in `site/`, where direct `Error.isError(...)` throws `TypeError: Error.isError is not a function`. Direct calls are blocked by ESLint `no-restricted-syntax`; the rule allow-lists only the two polyfill modules. Keep `instanceof` only for same-realm custom error classes (e.g. `RunbookSyntaxError`, `RundownError`).
- **Mock injected core services structurally in non-core tests.** Tests in `packages/core` may construct real core services because they own that behavior. Tests outside `packages/core` that mock `@rundown-org/core` should pass object-shaped service doubles for injected dependencies (for example `actorService: { initializeState } as unknown as RunbookActorService`) instead of calling `new core.RunbookActorService(...)` from a mocked module. Use explicit mock constructors only when production code constructs the service and constructor behavior is part of the test.

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

See [docs/reference/cli.md](docs/reference/cli.md#output-format) for full output formatting standards.

## Internal Command Execution

In WebContainer environments where nested process spawning doesn't work, the CLI intercepts `rd`/`rundown` commands and executes them directly:

- `packages/cli/src/services/internal-commands.ts` - Dispatcher for internal command execution
- `isInternalRdCommand()` - Detects rd/rundown commands
- `executeRdCommandInternal()` - Executes commands without spawning

Currently supported internally: `echo`, `prompt`. Unsupported commands fall back to spawn.

## Documentation

See **[docs/README.md](docs/README.md)** for the full documentation index, organized by audience and task.

## Conceptual Model

Three distinct concepts govern step execution. Never conflate them:

| Concept | Domain | Examples |
|---------|--------|----------|
| **RESULT** | Outcome of execution | `pass`, `fail` |
| **HANDLER** | Configured mapping from result to action | `PASS CONTINUE`, `FAIL DEFER` |
| **ACTION** | What to do next | `CONTINUE`, `NEXT`, `BREAK`, `DEFER`, `STOP`, `COMPLETE`, `GOTO` |

A step produces a **result** (pass/fail). The runbook's **handler** for that result determines the **action** to take. These are separate layers — a result is not an action, and a handler is not a result.

## Design Principles

These principles govern state-machine internals and implementation style. They sit underneath the [Architectural Principles](#architectural-principles) — the latter constrains *where* logic lives; these constrain *how* it is written.

**Type-driven dispatch.** Types drive logic everywhere possible. Use discriminated unions and type narrowing to make invalid states unrepresentable. Guards express domain conditions through typed return values, never raw action-type string checks. If logic branches on a string discriminant, that discriminant should be encoded in a purpose-built type that forces callers to narrow before accessing variant-specific fields. `if` statements checking action types in guards are code smells — missing type structure. See [docs/internal/architecture.md](docs/internal/architecture.md#design-principles) for state machine specifics.

**No silent mapping.** Actions like STOP, COMPLETE, BREAK must propagate as themselves. Never silently convert one action type to another (e.g., mapping DEFER to CONTINUE). Each action type has distinct semantics that must be preserved through the entire dispatch chain.

**No synthetic IDs.** Don't create artificial state identifiers (like `~channel` prefixes). Use XState's native event system and state graph structure.
