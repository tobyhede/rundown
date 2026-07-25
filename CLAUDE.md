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

`@rundown-org/cli` ships two binaries — `rundown` and a short `rd` — pointing at
the same CLI. **Always instruct `rundown`**: oh-my-zsh's core `alias rd=rmdir`
shadows the `rd` bin (shell aliases beat `PATH`), so agent-facing docs, skills,
and runtime guidance MUST use `rundown`. Humans may restore `rd` with
`alias rd=rundown` after oh-my-zsh loads. Output is **JSON by default** on every
command; that is the agent-facing format. `--text` is human-readable output for
humans/debugging only — **agents must not add it.** Appending `--text` to an
agent-driven command (such as starting a runbook) is exactly the drift this
surface must not invite.

The full command and flag surface is canonical in the reference docs — **do not
duplicate or reconstruct it here.** When stepping through a runbook, follow the
`running-runbooks` skill for the execution protocol (when to
`rundown pass`/`rundown fail`, claim/delegate, JSON vs `--text`) rather than the
raw flag list.

Post-R1, mutating commands on delegation-exposed runs must name their authority
with `--claim-id`: orchestrators pass the run-control claim minted by
`rundown run` (the `claim_id` on the `runbook_started` event), children pass the
bearer claim from `rundown claim`; bare forms refuse with
`ACTOR_CONTEXT_REQUIRED`. `--run <rd_…>` (run id from `rundown run` output /
`runbookId` on events) is a read-only target selector only — never mutation
authority: combining it with `--claim-id` is rejected `INVALID_SYNTAX`, and
using it to mutate a delegation-exposed run is refused `ACTOR_CONTEXT_REQUIRED`.
Read-only commands stay bare.

- [docs/reference/cli.md](docs/reference/cli.md) — every `rundown`/`rd` command
  (run, pass/fail, goto, status, stop, complete, stash/pop, ls, check, resolve,
  echo, prune, scenario, scenario-suite, prompt, delegate, claim, abort,
  collect) with flags and `--run` / `--step` / `--index` / `--claim-id`
  semantics
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
rundown run write-plan              # Resolves via priority chain
rundown run rundown:write-plan      # Explicit: from plugin
rundown run rundown:nonexistent     # Error: not found in rundown namespace
```

The `rundown` namespace maps to the plugin source
(`@rundown-org/claude-code-plugin`).

### Listing Runbooks

```bash
rundown ls --all                    # List all discoverable runbooks with source
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

All package scripts live in `package.json` — run `pnpm run` to list them
(`build`, `test`, `test:unit`/`integration`/`all`/`coverage`/`property`/`perf`,
`lint`, `check:*`, `fix:*`, `format`, `test:mutate:*`, `verify:claude*`,
`test:e2e*`). The one hard rule and the non-obvious invocations:

- **`pnpm run verify`** — pre-PR gate (format, spell, lint, test). **MUST run
  before every push.** Scoped `jest` runs are not a substitute: spelling
  (`cspell`) and typed lint (`jsdoc/require-throws` and friends) only run here,
  so a change can be green in every targeted suite and still fail the gate.
- **Biome owns JS/TS/JSON/CSS; Prettier is Markdown-only** (`.prettierignore`
  line 1). **Never run `prettier` on TypeScript** — it reformats to a different
  quote/width style, and `biome format` will not undo it because it preserves
  author-expanded literals, so the damage has to be reverted by hand. Use
  `npx biome check --config-path=. --write <files>`, or `pnpm run format` for
  the whole repo. Note `verify` runs Biome twice: `check:format` disables the
  linter, and `check:lint:fast` (`biome lint .`) disables nothing but exits 0 on
  warning-severity findings — so a `warn` rule such as
  `noUnusedPrivateClassMembers` is reported by `verify` and still passes it.
  ESLint (`check:lint:typed`) is the linter whose findings block.
- **`pnpm run test:mutate:changed`** — the default way to mutation-test your own
  work, and what an agent should reach for first. It derives the diff base
  (merge-base with `main`) and runs **one Stryker invocation per changed source
  file**, each scoped to that file's changed `file:start-end` ranges (whole-file
  only when the file is new or under 300 lines) and to that file's dedicated
  unit test, then scores each file through `assert-mutation-score.mjs`. It
  encodes every foot-gun below by construction, adds `--force` (mandatory, see
  below), and fails loudly when Stryker instrumented 0 files — the silent no-op
  that a hand-written `--mutate` reports as success.

  ```bash
  pnpm run test:mutate:changed                    # every changed package
  pnpm run test:mutate:changed --package core     # one package
  pnpm run test:mutate:changed --print            # show the plan + commands, run nothing
  pnpm run test:mutate:changed --related-tests    # drop --testFiles, use findRelatedTests
  ```

  **Read a survivor correctly.** Scoping to one dedicated test disables the jest
  runner's `--findRelatedTests`, so a mutant killed only by an integration test
  reports as a **survivor**. That is the intended reading — "this module's own
  unit tests do not kill this mutant independently", which is what Stryker
  documents `testFiles` for — not "nothing in the suite covers this". Pass
  `--related-tests` to check the broader question, at roughly 13x the cost per
  mutant on a widely-imported module.

  **`--force` is not optional.** Every package config sets `incremental: true`,
  so without `--force` Stryker may serve cached results from the `main` baseline
  for the very lines you changed, and the score you read is main's. The Stryker
  docs call `--force` "especially beneficial when combined with a custom
  `--mutate` pattern" for exactly this reason. It is scope-limited, so the
  full-report benefit of incremental mode is preserved.

  **Never tune `timeoutMS` down for speed.** Timeout is a _detected_ state
  (score is `detected / valid`, detected = `killed + timeout`), so a spurious
  timeout inflates the score by crediting a kill no test performed. Measured on
  `src/paths.ts`: 60000ms gives 11 Killed / 15 Timeout / 2 Survived = 78.79%;
  8000ms gives 0 Killed / 31 Timeout / 0 Survived = 86.11% — both real survivors
  erased. Reduce mutant count (ranges) or tests per mutant (`testFiles`)
  instead.

  Reach for the manual form below only when you need a scope the diff does not
  describe (a single function, a file you did not touch).

- **Scoped Stryker run** (any package) — use `exec`, and pass
  **package-relative** paths:

  ```bash
  pnpm --filter @rundown-org/cli exec stryker run \
    --mutate src/helpers/table-formatter.ts \
    --testFiles __tests__/helpers/table-formatter.test.ts
  ```

  This is the canonical form. **Never run an unscoped Stryker run** — no
  `pnpm run test:mutate:<pkg>` without `--mutate`, and never the package glob.

  **Scope to changed lines, not to a file.** Whole-file `--mutate` is only
  appropriate for a small file (roughly < 300 lines) or one that is entirely
  new. Pointing it at a large existing module is a full run wearing a scoped
  flag: `runbook-store.ts` is ~1450 lines, so mutating it whole to cover a
  ~280-line change ran 17+ minutes without finishing. Use line ranges, which
  Stryker accepts as `file:start-end` and comma-separates:

  ```bash
  # ranges from: git diff -U0 <file> | grep -E '^@@'
  pnpm --filter @rundown-org/core exec stryker run \
    --mutate 'src/runbook/storage/runbook-store.ts:693-820,src/runbook/storage/runbook-store.ts:1219-1240' \
    --testFiles __tests__/runbook/storage/runbook-store.test.ts
  ```

  Judge the result on survivors **in the lines you changed**, never on the
  aggregate score: a scope this narrow makes the percentage meaningless, and the
  70% break threshold will fail the run regardless.

  Check the `Instrumented N source file(s) with M mutant(s)` line before
  trusting any score — `N > 0` is what proves the scope actually resolved. Two
  ways a scoped run can lie about success:
  - Do **not** insert the `--` separator:
    `pnpm --filter … exec stryker run -- --mutate <file>` (or
    `pnpm run test:mutate:<pkg> -- --mutate <file>`) dies on
    `error: too many arguments for 'run'` because pnpm forwards the literal `--`
    into Stryker's Commander as a positional. The `test:mutate:<pkg>` root
    scripts delegate to the `exec stryker run` form above, so the bare shortcut
    `pnpm run test:mutate:<pkg> --mutate <pkg-relative-path>` (no `--`) forwards
    cleanly and scopes correctly; adding the separator is the foot-gun.
  - Repo-relative paths (`--mutate packages/cli/src/x.ts`) match nothing:
    `pnpm --filter … exec` runs with cwd = the package dir, so Stryker reports
    `Instrumented 0 source file(s) with 0 mutant(s)` and **exits 0** — a gate
    that cannot fail. Each `stryker.config.mjs`'s own `mutate` array is
    package-relative (`'src/**/*.ts'`) for the same reason, and so are the
    scopes `scripts/lib/mutation-scope.mjs` emits for both the local runner and
    CI.

  Note `incremental: true`: a stale `reports/stryker-incremental.json` can print
  a plausible aggregate over a zero-mutant run — pass `--force` (as
  `test:mutate:changed` does) so a hand-run scope is actually executed rather
  than replayed. **Core is included in the per-PR matrix**, as one shard per
  changed file; that workflow is advisory (`continue-on-error` throughout, no
  required check), so it reports but never blocks.

- `pnpm run plugin:dev -- --no-build` (skip rebuild) /
  `pnpm run plugin:dev -- -- --debug hooks,plugins` (forward flags to `claude`).
- `pnpm run test:e2e:shell -- <path>` (mount a project) / `-- --bash` (debug
  shell) / `-- --no-build` (cached image).

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
- **CLI tests default to JSON output.** Rundown commands emit JSON by default
  and `--text` is the human-facing alternate format. Tests that verify command
  contracts, error envelopes, schema compatibility, machine-readable fields,
  token redaction, or exit-code behavior should exercise the default JSON path
  first. Add `--text` only when the test is explicitly about human-readable
  rendering, demo/scenario transcript readability, or when setup output is
  irrelevant and the test verifies state directly. For non-trivial CLI output
  changes, cover JSON and text separately rather than using text output as a
  proxy for the JSON contract.

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

**Descriptive vs prospective — never conflate them.** Documentation splits on
whether it describes code that exists _today_ or code we _intend_ to build:

- **`docs/internal/`** holds **descriptive** docs — the **current** design,
  architecture, and implementation. These are living documents, edited in place
  as the code changes. They describe how the system works right now.
- **`docs/superpowers/`** holds **prospective** docs — dated, write-once specs
  (`specs/`), implementation plans (`plans/`), and design notes (`notes/`) for
  work we plan to do. A new design for the same feature becomes a new dated
  file; existing ones are never overwritten. Trackable issues and follow-up work
  belong in GitHub issues, not in-repo docs.

Roadmaps belong in GitHub epic issues, not dated `docs/superpowers/` files. Use
an `Epic:` issue for the overall roadmap, `Cluster:` issues for coherent
implementation clusters, and leaf issues for concrete defects or features. Link
the hierarchy with GitHub parent/sub-issue relationships when available, and
keep the readable issue body checklist in sync. Put cluster-level agent handoff
plans in `docs/superpowers/plans/` only when they contain actionable
implementation steps.

Litmus test: a dated filename (`YYYY-MM-DD-…`) or a description of unbuilt work
is **prospective** and belongs under `docs/superpowers/` — never in
`docs/internal/`. Put the current design in `docs/internal/`; put the plan for
changing it in `docs/superpowers/plans/`.

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
