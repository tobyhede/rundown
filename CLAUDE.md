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

When multiple CLI processes may mutate a file-backed artifact such as the
artifact manifest, use **file-based exclusive locks** with process-aware stale
lock reclamation. Run and session authority lives in SQLite and uses database
transactions and execution leases instead.

**The replacement is not equivalent, and the difference is a failure mode, not a
detail.** A file lock _blocks_ a contender for up to 5s and then usually
succeeds. Of the two mechanisms that replaced it, only one behaves that way:

- **Transaction contention** (`mutateSession`, and every `BEGIN IMMEDIATE`
  write) blocks like the lock did — `PRAGMA busy_timeout = 5000` inside SQLite
  plus 10 application-level retries at 25ms × attempt in the native driver.
- **The optimistic CAS** behind `RunbookStore.mutateState` — the per-run
  read-modify-write behind every run-state write — waits, but does not block. It
  replays the whole cycle at most **8 times**, pausing between attempts for a
  jittered interval scaled by attempt number (25–50ms × attempt, so at most
  ~1.4s across the default budget). The jitter is what lets more concurrent
  writers than the attempt budget all commit: without it the losers re-read in
  lockstep and the writer at the back of the queue exhausts the budget before
  its turn. Sustained contention still spends the budget, and the call then
  returns `concurrent_modification` — a command failure where the lock would
  have waited and won.

Treat `concurrent_modification` as a reachable arm on any path that can be
driven concurrently — handle it or retry it, and never document it as
theoretical. `build` callbacks passed to `mutateState` run once per attempt and
MUST therefore be free of external side effects.

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
The artifact manifest and the sql.js driver call them directly;
`PluginSessionLock` re-exposes them as `scope()` / `held()`.

- **Lock mechanism:** Atomic file creation (`fs.open(..., 'wx')`) on
  `.rundown/locks/<name>.lock`
- **Stale detection:** Kill signal check (`kill(pid, 0)`) — never age-based
  expiration
- **Retry:** Jittered backoff (50–100ms) bounded to 5 seconds
- **Release:** Best-effort and idempotent. A failed unlink only leaks a
  self-healing lock (reclaimed by the next acquirer via PID-aware stale
  detection) and is **never propagated** by the disposer, so it cannot mask the
  committed outcome of the protected work. Never release a lock from a bare
  `finally` — that is the RD-102 masking defect.

**Examples:** three consumers remain, and every one of them protects a
file-backed artifact rather than run or session authority — the artifact
manifest, the sql.js driver's durable-replacement cycle, and the plugin's
`PluginSessionLock`. Do not add a fourth for run or session state: that belongs
in a transaction or in the compare-and-swap. Note also that `acquireFileLock` is
**not reentrant** — a second acquisition on the same call path blocks its own
predecessor for the full 5s deadline and then times out, so a lock reached twice
within one process is worse than no lock at all.

**Writing a decision a concurrent writer could invalidate.** Derive it
**inside** the `mutateState` build callback, so it is computed against the exact
version the compare-and-swap commits onto and a loser re-derives against the
committed row rather than overwriting it. Do not reach for a transaction instead
— `SyncWork<T>` makes an async callback a compile error, and these spans await.
This fold is what retired every run-state, completion, and delegation lock the
codebase used to hold; four rules generalise from it.

- **Fold the interface, not just the write.** A seam taking a caller-supplied
  `currentState` is stale by construction, and the compare-and-swap does not
  rescue it: it prevents the lost update while still applying a row selected
  against one version to the cursor of another. `applyNextResolvedCompletion`
  applies ONE completion and takes no `currentState`; the loop lives in the CLI,
  which needs it anyway to observe each transition. A change that fixes the
  write and leaves the parameter has kept the defect.
- **Audit the callback for repeatability rather than assuming it.** It re-runs
  once per attempt (up to 8) and must perform no external effect — filesystem
  resolution, dynamic imports, run creation, and emitted warnings all stay
  outside it, and the callback decides only. A clean audit is still a result
  worth recording: the drain's reachable machine actors are effect-free for its
  event apart from producer ARTIFACTS resolution, which is idempotent by
  identity and already repeats on RETRY re-entry.
- **Pick the builder the derivation needs.** An async derivation produces a
  whole state and needs `RunbookStateManager.mutateStateReturning`; a
  patch-shaped one uses `updateWithStateReturning` or `updateWithStateIfExists`,
  whose `null` return on a missing run IS the pre-read existence guard.
- **When the fold is unavailable, loop from outside** — and confirm it is
  unavailable rather than assuming. If the derivation is async and the commit's
  work is `SyncWork`, no callback can hold the span, so wrap capture → derive →
  commit in a bounded re-derive loop paced by the store's exported
  `DEFAULT_MUTATE_ATTEMPTS` / `mutateBackoffMs`, never a mirrored constant.
  Retry only the ambiguous arm: a version mismatch carries no reason, which is
  the point of re-deriving, while every permanent refusal stays permanent. Never
  re-run the side effect the loop sits inside, and let an exhausted budget
  report `concurrent_modification` rather than a cause it never observed.

**Exactly-once entry is a different shape from a read-derive-write gap.** Where
the protected span cannot live inside a callback at all — a launch, a run
creation — the replacement is an atomic **compare-and-latch**: a prior
`mutateStateReturning` cycle whose callback decides the entire question against
the version it commits onto (refuse, stand down, or win) and writes the durable
"I own this" record in the same commit, with only the winner performing the
span. Decide every refusal **ahead of** the latch write, or a refused attempt
leaves a durable record of a start that never happened. Latching before the
create does move one failure: a process that dies between them leaves the work
latched with no child, and recovery is the sanctioned one (finish, stop, prune)
rather than a duplicate `INSERT`.

**Three checks that are cheap to run and expensive to skip.**

- **Establish what an exclusion actually excludes before crediting it with an
  invariant.** The run-start delegation lock fenced a load-derive-write over the
  parent's `substepStates` and lost updates the whole time, because it excluded
  only other acquirers of itself while every writer of those rows (`delegate`,
  `pass`, `fail`, `goto`, `abort`) went through the state machine and took no
  lock at all. "It was load-bearing" and "it was decoration over a live defect"
  need the same fix but are different changes — only the second is a
  user-visible bug fix.
- **Check what each refusal DEGRADES to, not only that correctness holds.**
  Deleting an exclusion makes a formerly impossible race reachable, and the
  refusal it produces has to be spelled correctly at every seam it surfaces
  through: an occupied delegation is permanent, so it classifies
  `already_linked` (no retry) and never `concurrent_modification` ("Retry.") — a
  call that can never succeed must not tell the caller to try again. A wrapper
  that folds failures into a generic envelope re-labels it, so pass every reason
  a concurrent actor can cause through as itself. Move each refusal into the
  transactional owner FIRST, one commit at a time; deleting the exclusion is
  then a no-op rather than a lossy edit.
- **"Stub it out and see what breaks" is a BLIND check** when every unit suite
  mocks the module boundary you stubbed. Nothing fails, and nothing was tested.
  Only a real multi-process test observes a genuine race.

**For manifest writes:** Wrap `findEquivalentManifestRow` + append in a lock
derived from `manifestPath(cwd)` + `.lock`.

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

Run and session state persists in `.rundown/rundown.db`. Captured outputs remain
under `.rundown/runs/<run-id>/outputs/`. Runbook source files are discovered
from multiple locations (see [Runbook Discovery](#runbook-discovery)). State
persists across context clears.

<important>
**Principle:** NEVER migrate persisted runbook state between versions.
</important>

**Principle:** Never migrate persisted runbook state between versions. This
applies to all run data written to SQLite: structured `RunbookState` fields
(step, variables, lifecycle, etc.) and the opaque `state.snapshot` blob stored
inside `RunbookState`. Neither is exempt. Persisted runbook state carries the
schema version in `CURRENT_SCHEMA_VERSION`
(`packages/core/src/runbook/persisted-state-guards.ts`, currently `2`); state
with any other schema version or incompatible structure is invalid. On schema
changes, running runbooks should be completed/closed and restarted. The CLI
should detect invalid state (via schema version or structural guard) and prompt
the user to finish or prune — never silently adapt, rewrite, or shim the data.

**Change the shape, move the version — in the same commit.** Any edit to the
persisted run-state shape (`RunbookState` in `runbook/types.ts`,
`RunbookStateObjectSchema` or its nested schemas in `schemas.ts`) MUST move
`CURRENT_SCHEMA_VERSION`, because that constant is the only thing that refuses
state an older build wrote. Widening an optional field is the sole exception —
state written before the widening still parses. Adding a required field,
removing a field, and narrowing an existing one all require the bump; the last
is the one that looks harmless and is not. This is not hypothetical: #746, #772
and #827 each added a required field and left the version at `1`, which routed a
mid-inline-launch run into a bare `ZodError` out of `RunbookStore.readRun` —
outside the CLI's recovery taxonomy, so `finish`/`stop`/`prune` could not clear
it (#775).

`packages/core/__tests__/runbook/persisted-state-shape.test.ts` fails when the
shape moves and the recorded fixture does not. It reports the changed fields;
the remedy is to bump the constant and record the new shape as
`schema-v<new>.txt`, never to overwrite the existing file. It does **not** cover
the opaque `snapshot` blob (see below) or the body of a `.refine()`, so those
still need the bump decided by hand.

**Fixtures name the constant; they never hard-code the number.** State meant to
be readable uses `CURRENT_SCHEMA_VERSION`, state meant to be refused uses
`CURRENT_SCHEMA_VERSION + 1`. A literal in either position is what made #775
invisible for three PRs: a "valid" fixture pinned to `1` could not notice the
constant going stale, and a "foreign" fixture pinned to `2` silently became
valid current state the moment the constant reached it, asserting nothing while
still passing.

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

## Versioning and changesets

**Rundown is unreleased. Nothing is published, and there are no downstream
consumers.** The same reasoning that retires persisted-state migrations (see
[State Persistence](#state-persistence)) applies to package versions: there is
no one to break.

Therefore **do not spend effort on semver correctness**, and never raise it as a
review finding. Specifically, none of the following is a defect worth reporting,
a reason to open a PR, or a reason to block one:

- A `patch` bump on a changeset that removes or changes public API.
- A bump that disagrees with what another changeset chose for a similar change.
- Any argument of the form "a consumer on `^1.0.0` would break" — that consumer
  does not exist.

Write a changeset because it is the release note: it explains **what changed and
why** to the next person reading the history. That prose is worth getting right.
The `major`/`minor`/`patch` field on it is not — pick one and move on. When the
project ships for real, versions start mattering and this section gets deleted.

The corollary for reviewers, human or agent: **a finding whose only consequence
lands on a hypothetical consumer is out of scope.** Rank findings by whether
they can affect this repo's behaviour, its tests, or a reader's understanding of
the code. Version metadata affects none of the three.

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
- **`pnpm run verify:site` — `verify` type-checks `site/` but does not run its
  behaviour.** `check:types:site` (`astro check`, ~5s) is in the `verify`
  fan-out, and is the directory's _only_ gate there: Biome, cspell, and Prettier
  all exclude `site`, and no Playwright runs. Two regressions on the
  single-store branch reached CI through that hole, so `site/tsconfig.json`
  enables `exactOptionalPropertyTypes` — plain `astro/tsconfigs/strict` does not
  catch passing `recursive: undefined` to a strictly-typed `fs.rm`, which was
  one of them. **Touching `site/src` still means running
  `pnpm run verify:site`** (snapshot build, then Playwright) in addition to
  `verify`; it stays separate because the snapshot build plus browser run costs
  minutes and most changes never touch `site/`. See
  [site/CLAUDE.md](site/CLAUDE.md) for the dev-server foot-gun.
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
  only when the file is new) and to that file's dedicated unit test, then
  reports every in-scope Survived or NoCoverage mutant through
  `assert-mutation-score.mjs`; the percentage is secondary context. For a
  test-only change it uses Stryker's native incremental analysis and compares
  stable mutant IDs with an existing baseline, refusing an unbounded cold run
  when no baseline exists. It encodes every foot-gun below by construction, adds
  `--force` to every source-change scope (mandatory there, see below), and fails
  loudly when Stryker instrumented 0 files — the silent no-op that a
  hand-written `--mutate` reports as success.

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

  The advisory PR workflow uses the same hybrid: custom changed ranges for
  source changes, native incremental analysis for test-only changes. Dedicated
  tests are the default fast tier; add the `mutation:related` PR label (or
  choose `related` in a manual dispatch) to retain Jest's related-test fallback.

  **`--force` is not optional on a source-change scope.** Every package config
  sets `incremental: true`, so without `--force` Stryker may serve cached
  results from the `main` baseline for the very lines you changed, and the score
  you read is main's. The Stryker docs call `--force` "especially beneficial
  when combined with a custom `--mutate` pattern" for exactly this reason. It is
  scope-limited, so the full-report benefit of incremental mode is preserved.
  The **test-only tier is the deliberate exception**: it passes bare
  `--incremental` and no `--force`, because that tier's entire method is diffing
  stable mutant IDs against the retained baseline — a forced cold rerun would
  discard the very results it compares against.

  **Never tune `timeoutMS` down for speed.** Timeout is a _detected_ state
  (score is `detected / valid`, detected = `killed + timeout`), so a spurious
  timeout inflates the score by crediting a kill no test performed. Measured on
  `src/paths.ts`: 60000ms gives 11 Killed / 15 Timeout / 2 Survived / 5
  NoCoverage = 78.79%; 8000ms gives 0 Killed / 31 Timeout / 0 Survived / 5
  NoCoverage = 86.11% — both real survivors erased. Reduce mutant count (ranges)
  or tests per mutant (`testFiles`) instead.

  **Concurrency is bounded for you — mutation runs are memory-bound, not
  CPU-bound.** Every package config reads `STRYKER_CONCURRENCY` (default **2**).
  That number is not the process count: Stryker spawns a test-runner worker
  _and_ a TypeScript checker worker per unit, so `concurrency=2` is **four**
  Node processes, each holding the whole instrumented module graph. Memory
  scales with the size of the mutated file, not with the number of mutants, so a
  big module is where this bites: measured on a ~3600-line revision of
  `lifecycle-command-service.ts`, `concurrency=2` ran 4 workers at 3–4 GB each —
  **~14 GB**, enough to make the machine unusable for everything else.

  `test:mutate:changed` therefore sets `STRYKER_CONCURRENCY=1` itself on a
  source-change scope whose mutated file exceeds `LARGE_SOURCE_FILE_LINES`
  (1000, in `scripts/lib/mutation-scope.mjs`, re-exported from
  `scripts/mutate-changed.mjs`). The CI producer's shard planner keys off the
  **same** constant, dropping a shard that mutates a file over it to concurrency
  2 — one threshold, two policies, so they cannot drift. **Do not set it by hand
  for that path** — an explicit `STRYKER_CONCURRENCY` in the environment always
  wins, so doing so only overrides a size-aware default with a flat one. Two
  paths the automatic bound does **not** cover:
  - **The test-only tier.** It passes no `--mutate` scope, so it mutates the
    whole package glob — the largest instrumented graph there is, and the worst
    case for the blow-up this bound exists to prevent — at the default 2. There
    is no file size to key on, so bound it yourself if that tier starts
    swapping.
  - **The manual `exec stryker run` form below**, which never goes through the
    script. Set the variable yourself, as its large-file example does.

  Bound it by hand whenever anything else is running concurrently (another
  agent, a `pnpm run verify`, a dev server) — a mutation run must never be the
  reason a developer's machine starts swapping. The default 2 is for a small,
  isolated scope. Raising it above 2 needs a specific reason and a machine with
  the RAM to match.

  Concurrency trades wall-clock for memory and nothing else — it does not change
  which mutants are tested or whether they are killed — so lowering it is always
  safe for correctness. That makes it the **first** knob to reach for when a run
  is too heavy, ahead of narrowing scope, and far ahead of `timeoutMS`, which is
  never a legitimate knob (see above).

  If you kill a mutation run mid-flight, kill the whole tree — the workers are
  children of the `stryker` process and outlive a bare `kill` on the pnpm
  wrapper:

  ```bash
  pkill -f 'child-process-proxy-worker.js'   # the memory-holding workers
  pkill -f 'stryker run'                     # the parent
  ```

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
  # ranges from: git diff -U0 [<merge-base>] -- <file> | grep -E '^@@'
  # this form is unscripted, so bound concurrency yourself on a >1000-line file
  STRYKER_CONCURRENCY=1 pnpm --filter @rundown-org/core exec stryker run \
    --mutate 'src/runbook/storage/runbook-store.ts:693-820,src/runbook/storage/runbook-store.ts:1219-1240' \
    --testFiles __tests__/runbook/storage/runbook-store.test.ts \
    --force
  ```

  **Derive the ranges from the diff; never guess them.** A hand-picked range
  that is wider than the change sweeps in pre-existing untested code and reports
  it as your survivors. Measured on `lifecycle-command-service.ts`: a guessed
  `1240-1420` produced 12 in-scope Survived/NoCoverage mutants, **all twelve on
  lines the branch never touched**. The diff-derived scope over the same file
  reported none of them. Use
  `git diff -U0 <merge-base> -- <file> | grep -E '^@@'` and convert the
  `+start,count` hunks — and diff against the **working tree**, not
  `main...HEAD`, whenever you have uncommitted changes, or every line number is
  shifted relative to the file Stryker actually mutated.

  Judge the result on survivors **in the lines you changed**, never on the
  aggregate score: a scope this narrow makes the percentage meaningless. Run a
  hand-rolled scope with `STRYKER_SCOPED=true` (as `test:mutate:changed` does)
  so `thresholds.break` is nulled and a non-zero exit means the run actually
  failed; without it the floor judges a partial score and fails a fine run.

  **The report lists survivors from outside your scope.** With
  `incremental: true`, the textual report and the per-file table merge cached
  results for the whole project over the mutants this run actually tested, so a
  clean scoped run can print hundreds of `[Survived]` entries for files and
  lines you never mutated. This is the inverse of the two foot-guns below —
  those make a broken run look green, this makes a green run look broken — and
  it is why the only valid reading is to filter the survivor list by your own
  line ranges:

  ```bash
  # after a scoped run, keep only survivors inside the ranges you mutated
  grep -A2 '^\[Survived\]\|^\[NoCoverage\]' run.log | grep '<your-file>.ts:'
  ```

  Confirm `Instrumented N source file(s) with M mutant(s)` matches the scope you
  asked for before trusting any score: that count, not the survivor list, tells
  you what this run tested, and `N > 0` is what proves the scope resolved at
  all. Two ways a scoped run can lie about success:
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

  **A killed run leaves that report poisoned, and the next run hangs rather than
  failing.** If you `pkill` a run mid-flight (or it dies with workers live), the
  partially-written `stryker-incremental.json` makes every subsequent scoped run
  stall — measured on `output-channels.ts`: a scope that had just completed in
  seconds stopped dead at 4/20 mutants with the ETA climbing past 17m,
  reproducibly, across two different scopes and at both concurrency 1 and 2.
  `--force` does not rescue this; it forces re-execution but the report is still
  read first. The fix is to delete the report and re-run:

  ```bash
  rm -f packages/<pkg>/reports/stryker-incremental.json
  ```

  It is gitignored and regenerated by the next run, so deleting it costs only
  the incremental reuse of a baseline the kill had already corrupted. Reach for
  this whenever a scoped run that should take seconds is still going after a
  minute — the symptom is a stall, not an error, so nothing tells you.

- **The changed-code gates are the whole day-to-day signal.**
  `pnpm run test:mutate:changed` locally and the advisory per-PR check
  (`.github/workflows/mutation-pr.yml`) are what you act on. The full-fidelity
  producer (`.github/workflows/mutation.yml`) is **`workflow_dispatch`-only and
  deliberately occasional** — an operator runs it to seed the Stryker dashboard
  baseline the PR check diffs against, and the baseline going stale for weeks is
  the expected state, not a gap. Its `push`-to-main trigger and weekly cron were
  deleted (issue #670): the push run planned differentially, so it could never
  upload a baseline and only re-measured the diff the PR gate had already
  scored, and five weekly campaigns produced zero `core` and zero `parser`
  reports. **Do not add an automatic trigger back**, and do not treat a stale
  dashboard as a reason to start a campaign locally — a full campaign is ~40,000
  mutants and ~70 machine-hours.

  Numbers worth carrying, all measured (details in
  [docs/internal/mutation-testing-ci.md](docs/internal/mutation-testing-ci.md)):
  - **0.46 mutants per source line** across the tree (0.39–0.60 per package).
    That is the only reliable way to estimate a scope's size; absolute mutant
    counts go stale fast (core grew 53% in five weeks).
  - **Throughput spans 5.55–78 mutants/min and line count does not predict it.**
    Two core shards of essentially identical size (5860 and 5855 lines) ran 4.9x
    apart, because wall time follows `findRelatedTests` fan-out. Budget for the
    slow end.
  - **Total campaign work is flat in the shard budget** — sharding trades setup
    overhead for a shorter tail. The producer is sized at 2400 lines/shard,
    which plans **60 jobs** today → ~66 machine-hours, a 240-minute job cap, 3
    waves of this account's 20 concurrent job slots. Finer sharding buys nothing
    but waves that starve PR CI. `MAX_SHARD_JOBS` (80) is the **ceiling** at
    which the planner widens the budget, deliberately above the plan so core's
    growth does not immediately lengthen the tail.

- `pnpm run plugin:dev -- --no-build` (skip rebuild) /
  `pnpm run plugin:dev -- -- --debug hooks,plugins` (forward flags to `claude`).
- `pnpm run test:e2e:shell -- <path>` (mount a project) / `-- --bash` (debug
  shell) / `-- --no-build` (cached image).

## Testing Conventions

- **A test that reads a file outside its own package must be named
  `*.repo-asset.test.ts`.** Stryker copies only the package directory into
  `.stryker-tmp/sandbox-*`, which adds two path segments, so a `../../../../`
  traversal off `import.meta.url` lands on `packages/<pkg>/<path>` and the asset
  is gone. That is not a skipped assertion — it is a hard
  `There were failed tests in the initial test run.` abort that kills the whole
  mutation campaign before one mutant is tested, and it is invisible because the
  shard step is `continue-on-error`. Every package's `jest.config.shared.js`
  ignores the pattern in the sandbox and runs it normally.

  Prefer removing the traversal to renaming: a dependency should be located with
  `createRequire(import.meta.url).resolve('<pkg>')`, whose `node_modules` walk
  works from either tree, so the test keeps contributing mutation coverage.
  Reserve the rename for genuinely out-of-package assets (a repo-root doc, the
  `runbooks/` tree, a `scripts/**` build script).
  `scripts/__tests__/mutation-sandbox-assets.test.mjs` enforces both halves.

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

## Agent skills

### Issue tracker

Issues live in GitHub Issues on `tobyhede/rundown`, driven via the `gh` CLI. See
`docs/agents/issue-tracker.md`.

### Triage labels

The five canonical triage roles use their default label strings. See
`docs/agents/triage-labels.md`.

### Domain docs

Multi-context: a root `CONTEXT-MAP.md` over per-package `CONTEXT.md` files, with
ADRs at the root for system-wide decisions and under each package for local
ones. See `docs/agents/domain.md`.

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
