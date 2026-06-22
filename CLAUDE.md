# CLAUDE.md

Rundown is a format for defining executable runbooks using Markdown.

## Packages

- `@rundown-org/parser` - Markdown runbook parser
- `@rundown-org/core` - Core runbook state management and execution
- `@rundown-org/cli` - Command-line interface (`rundown`, `rd`)
- `@rundown-org/mcp` - MCP server for AI agent integration
- `@rundown-org/claude-code-plugin` - Claude Code plugin for runbook
  orchestration

## Architectural Principles

These principles are foundational. They take precedence over local convenience
and are not negotiable on a per-PR basis.

**State machine drives Rundown logic.** All runbook behaviour — step
transitions, result aggregation, action dispatch, lifecycle — lives in the
XState state machine in `@rundown-org/core`. Other packages MUST invoke the
state machine; they MUST NOT re-implement, replicate, or work around its logic.
If a desired behaviour isn't expressible in the state machine today, extend the
state machine — don't add a shadow implementation elsewhere.

**The CLI is a thin wrapper.** `@rundown-org/cli` exposes the core state machine
to agents and humans. Its job is to invoke state transitions and observe their
output (events, diagnostics, exit codes). Runbook logic does not live in the
CLI. New CLI commands must dispatch into existing core APIs; they do not
introduce parallel execution paths, hidden state, or transition rules of their
own. The same constraint applies to `@rundown-org/mcp` and
`@rundown-org/claude-code-plugin` — they are alternate front ends to the same
core.

**Core values, in priority order.** When trade-offs arise, resolve them in this
order:

1. **Correctness** — the behaviour matches the spec and the runbook author's
   intent.
2. **Type safety** — invalid states are unrepresentable; types drive dispatch
   (see [Design Principles](#design-principles)).
3. **Clean architecture** — small, self-contained modules with clear seams
   between packages and within packages.
4. **Test coverage** — every behaviour-bearing change is pinned by tests at the
   right layer (unit, integration, property, mutation).

**Correctness over pragmatism.** Prefer making the work correct over shipping a
"pragmatic" shortcut that compromises the values above. A workaround that papers
over a state-machine gap, an `any` that hides a typing bug, a skipped test that
masks a regression, or a one-off branch in the CLI that should have been a core
capability — all are net-negative regardless of the time they save in the short
term. When in doubt, raise the design question rather than patching around it.

### Side-effect categorisation

When a side effect needs to happen during runbook execution, classify it into
one of three categories before deciding where the code lives. The category
determines the architectural pattern.

| Category | Description                                                                                                       | Pattern                                                                                                                  | Examples                                                                                                    |
| -------- | ----------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------- |
| **A**    | Genuinely CLI. Inherently external to the runbook program.                                                        | Stays in CLI. CLI sends a typed event into the machine if state must update.                                             | stdin reads, terminal rendering, child-process `spawn` syscall, env-var reads, exit-code-to-process mapping |
| **B**    | Machine-owned. Logic is part of the runbook program. No external dependency.                                      | Machine invokes a `fromPromise` actor from core. Pure filesystem or pure computation.                                    | OUTPUTS capture, ARTIFACTS resolution, FOR iteration advancement, frontmatter `outputs:` storage            |
| **C**    | Machine-owned with DI callable. Logic is part of the runbook program, but execution requires an external service. | Machine invokes an actor parameterised by a callable supplied at machine-construction time. The callable is the DI seam. | Command execution (policy + spawn), helper invocation (helper registry)                                     |

Category B and C actors are placed under `packages/core/src/runbook/actors/`
(the directory is established by the first migration that needs it). Each actor
is a `fromPromise`-shaped function in its own file, takes a typed `input`,
returns a typed `output`, and does not know about the runbook state manager, the
actor service, or the CLI emitter. See
[docs/internal/architecture.md § Per-step substate pattern](docs/internal/architecture.md#per-step-substate-pattern)
for how the machine wires these actors into the per-step state graph.

A side effect that lives in the CLI but classifies as B or C is architectural
debt. The fix is to move it, not to rationalise its location.

### Concurrent write synchronization

When multiple CLI processes may mutate the same file (e.g.,
`.rundown/session.json`, run state, artifact manifest), use **file-based
exclusive locks** with process-aware stale lock reclamation:

**Pattern:** Acquire the lock, then scope its release with `await using` so the
lock is released deterministically on every exit path — including early `return`
and `throw` — without a hand-rolled `try/finally`:

```typescript
await lock.acquire(id);
await using _guard = lock.held(id); // or: await using _guard = await lock.scope(id);
return await doWork(); // a failed release can never mask this committed result (RD-102)
```

`acquireFileLock` / `releaseFileLock` (and the `*Sync` variants) in
`packages/core/src/runbook/file-lock.ts` are the underlying primitives;
`heldLock` / `heldLockSync` (returning `ScopedLock` / `ScopedLockSync`) are the
consumer-facing wrappers that own the best-effort, non-masking release policy.
Domain locks expose `scope()` / `held()` built on them.

- **Lock mechanism:** Atomic file creation (`fs.open(..., 'wx')`) on
  `.rundown/locks/<name>.lock`
- **Stale detection:** Kill signal check (`kill(pid, 0)`) — never age-based
  expiration
- **Retry:** Jittered backoff (50–100ms) bounded to 5 seconds
- **Release:** Best-effort and idempotent. A failed unlink only leaks a
  self-healing lock (reclaimed by the next acquirer via PID-aware stale
  detection) and is **never propagated** by the disposer, so it cannot mask the
  committed outcome of the protected work. Never release a domain lock from a
  bare `finally` — that is the RD-102 masking defect.

**Examples:** `CompletionLock`, `DelegationLock`, and `SessionLock`
(`packages/core/src/runbook/{completion,delegation,session}-lock.ts`) all expose
`acquire` + `scope()` / `held()`. `RunStateLock` (`run-state-lock.ts`) is the
exception: it is consumed through the narrow `RunStateLockLike` DI interface
(acquire/release only, so test fakes stay trivial), so its caller —
`RunbookStateManager.withRunStateLock` in `state.ts` — wraps `heldLock` inline
rather than calling a `held()` method. See the lock fixture tests under
`packages/core/__tests__/runbook/` (`*-lock.test.ts`).

**For manifest writes:** Wrap `findEquivalentManifestRow` + append in a lock
(e.g., `sessionLockPath(cwd)` if manifest is per-project, or derive a
manifest-specific lock path from `manifestPath(cwd)` + `.lock`).

### Actor dependencies

Machine-invoked Category B and C actors receive their inputs from two sources:
**compile-time-bound dependencies** (process state, service references,
parser-derived data, DI'd callables) flow through the per-state `invoke.input`
builder closure constructed inside `compileRunbookToMachine`; **event-time-bound
dependencies** (anything that varies per snapshot or per event) are read from
`context` inside the `invoke.input` factory at fire time. The corollary is
stricter than splitting the wiring: **persisted context contains only data;
runtime references flow through invoke-input closures.** Function references
cannot be serialised, process-runtime values like `cwd` may differ between the
writer and reader of a snapshot, and service instance references go stale across
process boundaries — routing each dependency through the right boundary is what
prevents these failures by construction. See
[docs/internal/architecture.md § Actor input wiring](docs/internal/architecture.md#actor-input-wiring)
for the implementation pattern and the canonical worked example.

## Installation

```bash
npm install -g @rundown-org/cli
```

## Commands

`@rundown-org/cli` ships two equivalent binaries — `rundown` and its alias `rd`.
Output is **JSON by default** on every command; that is the agent-facing format.
`--text` is human-readable output for humans/debugging only — **agents must not
add it.** Appending `--text` to an agent-driven command (such as starting a
runbook) is exactly the drift this surface must not invite.

The full command and flag surface is canonical in the reference docs — **do not
duplicate or reconstruct it here.** When stepping through a runbook, follow the
`running-runbooks` skill for the execution protocol (when to
`rd pass`/`rd fail`, claim/delegate, JSON vs `--text`) rather than the raw flag
list.

- [docs/reference/cli.md](docs/reference/cli.md) — every `rundown`/`rd` command
  (run, pass/fail, goto, status, stop, complete, stash/pop, ls, check, resolve,
  echo, prune, scenario, scenario-suite, prompt, delegate, claim, abort,
  collect) with flags and `--step` / `--index` / `--claim-id` semantics
- [docs/spec/cli-output.md](docs/spec/cli-output.md) — `--schema` JSON-output
  schemas for programmatic validation
- [docs/reference/security.md](docs/reference/security.md) — policy flags
  (`--allow-*`, `--deny-all`, `--sandbox*`, `--trust-js-policy`, `--helpers`)
  and policy-file discovery

### Sibling tools: rdpath, rdx

Minor bins of the plugin package (`@rundown-org/claude-code-plugin`) — **not**
part of the CLI package, and of decreasing importance as their functionality
moves into artifacts. Reach for them only when a runbook explicitly invokes
them. See [rdpath.md](docs/reference/rdpath.md) and
[rdx.md](docs/reference/rdx.md).

## Template Variables

Template variables use Handlebars syntax `{{variableName}}` and are expanded at
run time. The full precedence table, built-in variables list, and
context-passing semantics live in the specification:

- [docs/spec/language.md §9 Templating](docs/spec/language.md#9-templating) —
  precedence order, reserved keys, required variables
- [docs/reference/runtime.md Built-in Variables](docs/reference/runtime.md#built-in-variables)
  — `Date`, `Branch`, `WorkPath`, `RunId`, `ContextId`, `Step`, `Index`,
  `context.current.*`, plus plugin variables (`CLAUDE_PLUGIN_ROOT`)
- [docs/spec/language.md §10 Context Passing](docs/spec/language.md#10-context-passing)
  — OUTPUTS directives and frontmatter `outputs:` / `inputs:` fields

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

The `inputs` field is a list of names — declarations only, with no values. The
`required` field declares which of those variables the caller must provide;
names listed in `required` must also appear in `inputs`. Missing required
variables produce a hard error at resolution time. Provide values via `--input`,
`--input-file`, config, `RD_INPUT_*` env vars, or delegation inheritance.

**Notes:**

- Variable names must match pattern `/^[a-zA-Z_][a-zA-Z0-9_]*$/`
- Undefined variables are preserved as literal `{{variable}}` text
- Frontmatter `inputs:` declares names only — values come from `--input`,
  `--input-file`, `RD_INPUT_*` env vars, `.rundown/config.yaml`, or delegation
  inheritance. Use `--input-json`, `.rundown/config.yaml`, or `--input-file` for
  arrays and `file:` data sources
- `--input KEY` (without `=`) inherits the value of environment variable `KEY`

### Data Sources

Variables whose values are arrays or `file:`-prefixed paths become **data
sources** for FOR loop iteration. Template variables are expanded with `{{ }}`
syntax, while data sources drive `FOR variable IN {{ source }}` iteration:

| Value Type                  | Template Variable    | Data Source                | Example                              |
| --------------------------- | -------------------- | -------------------------- | ------------------------------------ |
| JSON array (`--input-json`) | Comma-joined         | Array DataSource           | `--input-json items='["a","b","c"]'` |
| `file:path/to/data.jsonl`   | JsonArrayStream ref  | File DataSource            | `--input items=file:data.jsonl`      |
| `file:path/to/data.json`    | JsonArray/JsonObject | File DataSource (if array) | `--input items=file:data.json`       |
| Array (YAML)                | Comma-joined         | Array DataSource           | `items: [a, b, c]` in config         |
| Scalar                      | String value         | Not set                    | `--input name=value`                 |

Data sources are referenced in FOR clauses: `FOR item IN {{ items }}`.

**File formats:** Only `.json` and `.jsonl` extensions are supported. `.jsonl`
files are parsed as JSON Lines (one JSON value per line). Each line may contain
any JSON value (string, number, boolean, null, array, or object). When the loop
variable holds a parsed JSON object, dotted field access is supported in
templates (e.g., `{{item.name}}`). Using `{{item}}` alone renders the serialized
JSON string. `.json` files are eagerly loaded as a `JsonObject` or `JsonArray`
value.

**Notes:**

- Arrays can be passed via `--input-json` (inline), `.rundown/config.yaml`, or
  `--input-file`. `file:` values are supported in `.rundown/config.yaml` and
  `--input-file` only. Frontmatter `inputs:` declares names only and does not
  carry values
- File paths must stay within the project root (symlinks resolved, traversal
  blocked)
- `file:` values are routed into the internal variable store as typed values
  (`JsonArrayStream` for `.jsonl`, `JsonArray`/`JsonObject` for `.json`)

**Note:** The `scenarios` frontmatter field is an internal testing/demo feature,
not part of the public Rundown format specification. See
[docs/internal/scenarios.md](docs/internal/scenarios.md).

## State Persistence

State persists in `.rundown/runs/` (execution state) and `.rundown/session.json`
(active runbook tracking). Runbook source files are discovered from multiple
locations (see [Runbook Discovery](#runbook-discovery)). State files persist
across context clears.

<important>
**Principle:** NEVER migrate persisted runbook state between versions.
</important>

**Principle:** Never migrate persisted runbook state between versions. This
applies to all data written to `.rundown/runs/`: structured `RunbookState`
fields (step, variables, lifecycle, etc.) and the opaque `state.snapshot` blob
stored inside `RunbookState`. Neither is exempt. For the v1 release, persisted
runbook state uses schema version `1`; state with any other schema version or
incompatible structure is invalid. On schema changes, running runbooks should be
completed/closed and restarted. The CLI should detect invalid state (via schema
version or structural guard) and prompt the user to finish or prune — never
silently adapt, rewrite, or shim the data.

There is no in-memory migration scenario. In-memory state does not survive
process restarts. Any state that reaches `createActor` originates from disk and
is subject to the same no-migration rule.

Rundown has no released compatibility contract for persisted runbook state.
Breaking active runs is acceptable and preferred over compatibility code for
consumers that do not exist. When a state shape, XState state ID, snapshot
context, variable layout, or run/session schema changes, update the current
model and reject incompatible persisted state. Do not add runtime migrations,
fallback parsers, legacy field hydration, compatibility shims, warning-only
adapters, or branches that preserve older behavior. The recovery path is always
explicit user action: finish, stop, prune, or restart from the source runbook.

## Runbook Discovery

Runbooks are discovered from multiple sources with the following priority
(highest to lowest):

| Source  | Location                        | Description              |
| ------- | ------------------------------- | ------------------------ |
| Project | `.rundown/runbooks/`            | Project-local runbooks   |
| Plugin  | `$CLAUDE_PLUGIN_ROOT/runbooks/` | Plugin-provided runbooks |
| Bundled | CLI package `dist/runbooks/`    | Bundled pattern runbooks |

Directories are scanned recursively, so subdirectory structures like
`planning/write-plan.runbook.md` are supported.

### Namespace Syntax

Use `namespace:name` syntax for explicit source targeting:

| Syntax               | Resolution                                 |
| -------------------- | ------------------------------------------ |
| `write-plan`         | Priority chain: project → plugin → bundled |
| `rundown:write-plan` | Explicit: from plugin only                 |

**Examples:**

```bash
rd run write-plan              # Resolves via priority chain
rd run rundown:write-plan      # Explicit: from plugin
rd run rundown:nonexistent     # Error: not found in rundown namespace
```

The `rundown` namespace maps to the plugin source
(`@rundown-org/claude-code-plugin`).

### Listing Runbooks

```bash
rd ls --all                    # List all discoverable runbooks with source
```

Output shows NAME, SOURCE, DESCRIPTION, and TAGS columns. The SOURCE column
indicates where each runbook was found (project, plugin, or bundled).

## Policy

Policy flags (`--allow-run`, `--allow-read`, `--allow-write`, `--allow-env`,
`--allow-all`, `--deny-all`, `--policy`, `--sandbox` / `--no-sandbox` /
`--sandbox-strict`, `--trust-js-policy`, `--helpers`) are registered at the
program level and usable with any subcommand. Policy files are auto-discovered
from `.rundownrc{,.json,.yaml,.yml}` and `package.json`; JavaScript config files
(`.js`, `.cjs`, `.mjs`) require explicit `--policy <path>` with
`--trust-js-policy`.

See [docs/reference/security.md](docs/reference/security.md) for the full policy
model, flag reference, and discovery rules.

## Environment Variables

- `RUNDOWN_LOG=0` - Disable logging (enabled by default)
- `RUNDOWN_LOG_LEVEL=debug|info|warn|error` - Set log verbosity (default: info)
- `RD_INPUT_<name>=<value>` - Set template variable `<name>` via environment
  (prefix stripped). E.g., `RD_INPUT_environment=staging` sets `{{environment}}`
- `NO_COLOR=1` - Disable colored output (standard convention)
- `FORCE_COLOR=1` - Force colored output even in non-TTY environments

## CI / Workflow Conventions

- **SHA-pinned actions**: GitHub Actions are pinned by commit SHA with a version
  comment (e.g., `actions/checkout@<sha> # v6`). This is intentional for
  supply-chain security. Do not replace SHAs with version tags.

## Development Commands

```bash
pnpm run build         # Build all packages
pnpm test              # Fast: unit tests, all packages in parallel
pnpm run test:unit     # Same as pnpm test
pnpm run test:integration  # Integration tests in parallel
pnpm run test:all      # Full suite: unit → integration → property → perf
pnpm run test:coverage # Test coverage across all packages
pnpm run verify        # Pre-PR: check format, spell, lint, test (MUST run before push)
pnpm run lint          # Lint all packages (biome + eslint)
pnpm run check:lint:fast   # Fast lint (biome only)
pnpm run check:lint:typed  # Typed lint (eslint only)
pnpm run check:complexity  # Standalone complexity checks (biome + eslint)
pnpm run fix:lint      # Auto-fix lint issues
pnpm run fix:lint:fast # Auto-fix biome lint issues
pnpm run fix:lint:typed # Auto-fix eslint lint issues
pnpm run format        # Format all packages
pnpm run check:format  # Check formatting
pnpm run check:spell   # Check spelling across all packages
pnpm run test:mutate   # Mutation testing (all packages, sequential)
pnpm run test:mutate:parser  # Mutation testing for parser only
pnpm run test:mutate:core    # Mutation testing for core only
pnpm run test:mutate:cli     # Mutation testing for cli only
pnpm run test:mutate:cli:dry # Verify CLI Stryker/Jest dry run only
pnpm run test:mutate:plugin  # Mutation testing for plugin only
pnpm run test:mutate:cli -- --mutate <file> --testFiles <test>  # Scoped CLI Stryker run
pnpm run test:property # Property-based tests
pnpm run test:perf     # Performance benchmarks
pnpm run plugin:dev       # Build + launch Claude Code with the local plugin via --plugin-dir
pnpm run plugin:dev -- --no-build              # Skip rebuild (faster iteration)
pnpm run plugin:dev -- -- --debug hooks,plugins # Forward flags to claude
pnpm run verify:claude    # Docker: verify CLI+plugin install (local build)
pnpm run verify:claude:npm  # Docker: verify install from npm registry
pnpm run test:e2e                              # Docker: E2E plugin workflow test
pnpm run test:e2e:shell                        # Docker: interactive Claude Code session (test-app fixture)
pnpm run test:e2e:shell -- ~/path/to/project    # Docker: interactive session with mounted project
pnpm run test:e2e:shell -- --bash              # Docker: bash shell for debugging
pnpm run test:e2e:shell -- --no-build          # Docker: skip rebuild (cached image)
pnpm run test:e2e:build                        # Docker: build E2E test image
```

## Testing Conventions

- **Use `isError()` / `isNodeError()` / `getErrorMessage()` from
  `@rundown-org/core`** (or `packages/claude-code-plugin/src/shared/errors.ts`
  inside the plugin) — never call `Error.isError()` directly. The helpers
  feature-detect native `Error.isError` (TC39 Stage 4, Node 24+) and fall back
  to `instanceof Error` so the codebase runs on hosts that ship older Node —
  notably WebContainer's bundled Node 22.x in `site/`, where direct
  `Error.isError(...)` throws `TypeError: Error.isError is not a function`.
  Direct calls are blocked by ESLint `no-restricted-syntax`; the rule
  allow-lists only the two polyfill modules. Keep `instanceof` only for
  same-realm custom error classes (e.g. `RunbookSyntaxError`, `RundownError`).
- **Mock injected core services structurally in non-core tests.** Tests in
  `packages/core` may construct real core services because they own that
  behavior. Tests outside `packages/core` that mock `@rundown-org/core` should
  pass object-shaped service doubles for injected dependencies (for example
  `actorService: { initializeState } as unknown as RunbookActorService`) instead
  of calling `new core.RunbookActorService(...)` from a mocked module. Use
  explicit mock constructors only when production code constructs the service
  and constructor behavior is part of the test.

## TSDoc Standards

All exported symbols must have TSDoc documentation following these requirements:

| Element                   | Required                                                                                           |
| ------------------------- | -------------------------------------------------------------------------------------------------- |
| Exported functions        | Description, `@param` for all parameters, `@returns` if non-void, `@throws` if exceptions possible |
| Exported interfaces/types | Description, property comments for non-obvious fields                                              |
| Exported classes          | Class description, constructor and public method documentation                                     |
| Type guards               | Description, `@param`, `@returns` with type predicate explanation                                  |
| Deprecated items          | `@deprecated` with migration guidance                                                              |

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

New CLI commands MUST use `OutputEmitter` for consistent output with
format-agnostic rendering. Import paths are relative to
`packages/cli/src/commands/`:

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

For direct table formatting (no JSON output support), use `formatTable` from
`../helpers/table-formatter.js` (also relative to commands/).

Key conventions:

- UPPERCASE headers, 2-space column separators
- Left-align text, right-align numbers
- JSON output by default; `--text` flag for human-readable output

See [docs/reference/cli.md](docs/reference/cli.md#output-format) for full output
formatting standards.

## Internal Command Execution

In WebContainer environments where nested process spawning doesn't work, the CLI
intercepts `rd`/`rundown` commands and executes them directly:

- `packages/cli/src/services/internal-commands.ts` - Dispatcher for internal
  command execution
- `isInternalRdCommand()` - Detects rd/rundown commands
- `executeRdCommandInternal()` - Executes commands without spawning

Currently supported internally: `echo`, `prompt`. Unsupported commands fall back
to spawn.

## Documentation

See **[docs/README.md](docs/README.md)** for the full documentation index,
organized by audience and task.

## Conceptual Model

Three distinct concepts govern step execution. Never conflate them:

| Concept     | Domain                                   | Examples                                                         |
| ----------- | ---------------------------------------- | ---------------------------------------------------------------- |
| **RESULT**  | Outcome of execution                     | `pass`, `fail`                                                   |
| **HANDLER** | Configured mapping from result to action | `PASS CONTINUE`, `FAIL DEFER`                                    |
| **ACTION**  | What to do next                          | `CONTINUE`, `NEXT`, `BREAK`, `DEFER`, `STOP`, `COMPLETE`, `GOTO` |

A step produces a **result** (pass/fail). The runbook's **handler** for that
result determines the **action** to take. These are separate layers — a result
is not an action, and a handler is not a result.

## Design Principles

These principles govern state-machine internals and implementation style. They
sit underneath the [Architectural Principles](#architectural-principles) — the
latter constrains _where_ logic lives; these constrain _how_ it is written.

**Type-driven dispatch.** Types drive logic everywhere possible. Use
discriminated unions and type narrowing to make invalid states unrepresentable.
Guards express domain conditions through typed return values, never raw
action-type string checks. If logic branches on a string discriminant, that
discriminant should be encoded in a purpose-built type that forces callers to
narrow before accessing variant-specific fields. `if` statements checking action
types in guards are code smells — missing type structure. See
[docs/internal/architecture.md](docs/internal/architecture.md#design-principles)
for state machine specifics.

**No silent mapping.** Actions like STOP, COMPLETE, BREAK must propagate as
themselves. Never silently convert one action type to another (e.g., mapping
DEFER to CONTINUE). Each action type has distinct semantics that must be
preserved through the entire dispatch chain.

**No synthetic IDs.** Don't create artificial state identifiers (like `~channel`
prefixes). Use XState's native event system and state graph structure.
