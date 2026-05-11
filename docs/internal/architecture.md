# Rundown Internal Architecture

This document describes Rundown's implementation architecture: the state machine design, core abstractions, design principles, and internal subsystems. For the CLI user reference, see [docs/reference/cli.md](../reference/cli.md). For the execution model and runtime semantics, see [docs/reference/runtime.md](../reference/runtime.md). For generic XState v5 + TypeScript patterns, see [xstate-patterns.md](./xstate-patterns.md).

---

## Architecture Overview

The Rundown system separates concerns into three layers:

| Layer | Component | Responsibility |
|-------|-----------|----------------|
| **Format** | `.runbook.md` files | Runbook definition (steps, transitions, commands) |
| **State Machine** | XState-compiled machine | State transitions and guards |
| **Persistence** | JSON files | Runbook state survives context clears |
| **Iteration** | ForIterationService | Per-iteration data source value resolution |

The CLI is an orchestration and control interface. Claude executes the actual work.

```text
[Runbook File] --> [Parser] --> [XState Machine] --> [State Manager]
                                       ^                    |
                                       |                    v
                              [CLI Commands] <---- [Persisted JSON]
```

---

## Design Principles

**Type-driven dispatch:** The state machine uses types and events to drive logic. Steps raise typed events; parent states dispatch on event type via `on:` handlers. Guards should express domain conditions (e.g., "has more iterations") through typed helpers where practical, rather than open-coded action-string checks. When code does inspect a discriminant such as `lastAction.type`, it should narrow a purpose-built union and keep variant-specific fields behind that narrowing. Example: `LastAction` is a discriminated union whose variants encode transition context. The `GOTO` variant carries target information that other variants like `CONTINUE` or `DEFER` do not, so TypeScript prevents accessing it without narrowing first. See [§ XState Compiler](#xstate-compiler) for how this principle is enforced through the hybrid named-action pattern.

**No silent mapping.** Actions like STOP, COMPLETE, BREAK must propagate as themselves. Never silently convert one action type to another (e.g., mapping DEFER to CONTINUE). Each action type has distinct semantics that must be preserved through the entire dispatch chain.

**No synthetic IDs.** Don't create artificial state identifiers (like `~channel` prefixes). Use XState's native event system and state graph structure.

### Typed `lastAction` discriminants

Machine-internal failures and step outcomes are signalled via the typed `LastAction` discriminated union, never via string-prefixed `lastMessage` parsing or other stringly-typed channels. Variants are defined in `packages/core/src/runbook/types.ts`: `START`, `CONTINUE`, `DEFER`, `GOTO`, `COMPLETE`, `STOP`, `RETRY`, `NEXT`, `BREAK`, and `RETRY_ERROR`. (`lastMessage` itself remains a legitimate diagnostic carrier for free-form context — what is forbidden is *type discrimination* via string parsing of it.)

When the CLI needs to react to a specific variant (typically to route to an `ERROR_OCCURRED` or `RUNBOOK_STOPPED { reason }` emission), it does so through a narrowing helper. The canonical example is `extractRetryError` in `packages/cli/src/services/execution.ts:375`:

```ts
function extractRetryError(snapshot: unknown): { code: string; message: string } | undefined {
  if (typeof snapshot !== 'object' || snapshot === null) return undefined;
  const ctx = (snapshot as { context?: unknown }).context;
  if (typeof ctx !== 'object' || ctx === null) return undefined;
  const lastAction = (ctx as { lastAction?: unknown }).lastAction;
  if (typeof lastAction !== 'object' || lastAction === null) return undefined;
  const record = lastAction as { type?: unknown; code?: unknown; message?: unknown };
  if (record.type !== 'RETRY_ERROR') return undefined;
  if (typeof record.code !== 'string' || typeof record.message !== 'string') return undefined;
  return { code: record.code, message: record.message };
}
```

Each helper narrows on `lastAction.type`, returns the variant-specific fields as a typed record, and is the only call site that touches the variant. New `LastAction` variants come with a corresponding extraction helper following the same shape.

---

## State Machine

The CLI compiles runbooks into an XState state machine. Each step (and substep) becomes a state. Events (`PASS`, `FAIL`, `GOTO`, `RETRY`) trigger transitions.

### Compilation

Runbooks compile to XState machines at runtime. Steps become states:

| Runbook Element | XState State ID |
|-----------------|-----------------|
| `## 1. Title` | `step::1` |
| `## 2. Title` | `step::2` |
| `### 2.1 Substep` | `step::2::1` |
| `## Cleanup` | `step::Cleanup` |
| `### Cleanup.verify` | `step::Cleanup::verify` |

Terminal states: `COMPLETE`, `STOPPED`

### Input Events

The state machine responds to these input events:

| Event | Trigger | Effect |
|-------|---------|--------|
| `PASS` | `rundown pass` or command exit 0 | Evaluate PASS transition |
| `FAIL` | `rundown fail` or command exit non-0 | Evaluate FAIL transition |
| `GOTO` | `rundown goto N` or GOTO action | Jump to step N |
| `RETRY` | FAIL + RETRY action | Increment retryCount, stay in state |

These input events are distinct from the action output recorded as `lastAction.type` after a transition resolves. The primary `LastAction` action variants are `START`, `CONTINUE`, `DEFER`, `GOTO`, `COMPLETE`, `STOP`, `RETRY`, `NEXT`, and `BREAK`; retry exhaustion may also surface the `RETRY_ERROR` variant (see `packages/core/src/runbook/types.ts`).

### Transitions

Default transitions when none specified:

```text
PASS CONTINUE
FAIL STOP
```

Transition evaluation:
1. Check condition (PASS or FAIL)
2. For RETRY: check if `retryCount < max`
3. Execute action (CONTINUE, COMPLETE, STOP, GOTO)

### Per-step substate pattern

Each leaf step state in the compiled machine may be augmented with sibling transient states that wrap side-effect invocations. Today only the **retry transients** (`::pass-retry`, `::fail-retry` — see `compiler.ts:2693, 2710`) exist; they increment retry counters and self-target back to the leaf state when the budget allows.

The pattern generalises for incoming side-effect-bearing transients (e.g. `::__capture-pass`, `::__capture-fail` for OUTPUTS capture, `::__resolve-artifacts` for ARTIFACTS resolution — both forward-looking, established by the artifacts-as-variables migration):

- **Side-effect-bearing transients**: invoke a Category B or C actor via `invoke.src` (see [`CLAUDE.md` § Side-effect categorisation](../../CLAUDE.md#side-effect-categorisation) for the A/B/C framework), chain `onDone` directly into the resolved transition target (precomputed via `buildTransition` for the corresponding outcome), and route `onError` to `STOPPED` with a typed `lastAction` discriminant.

Transient states are precomputed once per leaf state in the compile loop, alongside the existing PASS/FAIL transitions. They do not stash per-attempt state in `RunbookContext` — each variant of an outcome (pass vs fail) owns its own transient. Coordination state in `context` is an antipattern: it complicates persistence, creates ordering hazards in `assign`/`raise` interactions, and forces re-targeting the leaf state from `onDone` (which re-runs entry actions and risks duplicate observable events).

### Actor input wiring

A side-effect-bearing transient invokes a Category B or C actor (see [`CLAUDE.md` § Side-effect categorisation](../../CLAUDE.md#side-effect-categorisation)). The actor's `input` is assembled from two sources:

- **Compile-time-bound** dependencies are captured by the per-state `invoke.input` builder closure constructed inside `compileRunbookToMachine`. Examples: process state (`cwd`), service references (`RunbookStateManager`), parser-derived data (declarations attached to the step or substep), DI'd callables (a policy evaluator, a helper registry).
- **Event-time-bound** dependencies are read from `context` inside the `invoke.input` factory function at fire time. Examples: the current `runId`, captured variables, substep state, the result of a preceding command.

The wiring rule that makes this load-bearing is stricter than just "split the wiring":

> **Persisted context contains only data; runtime references flow through invoke-input closures.**

Three constraints back this up. `getPersistedSnapshot()` JSON-serialises context, so function references cannot be persisted at all. Even values that *can* serialise — a path string like `cwd` — may be process-runtime state that differs between the process that wrote the snapshot and the process that reads it; persisting them would silently produce wrong behaviour after a process boundary. And service instance references (a `RunbookStateManager`, a registry) become stale across process boundaries even when they marshal — the new process needs its own instance. The compile-time / event-time split routes each dependency through the right boundary so none of these failures can happen by accident.

Worked example — ARTIFACTS resolution (`::__resolve-artifacts` substate):

| Resolver field | Bound | Source |
|---|---|---|
| `cwd` | Compile | `evaluationOptions.cwd` (closure-bound) |
| `declarations` | Compile | `step.artifacts` / `substep.artifacts` (closure-bound to the per-state factory) |
| `workPath` | Event | `context.templateVars.WorkPath` (read in factory) |
| `contextId` | Event | `context.templateVars.ContextId` (read in factory) |
| `runId` | Event | `context.templateVars.RunId` (read in factory; branded with `assertRunId`) |
| `runbook` | Event | `context.templateVars.RunbookRef` (read in factory; validated with `RunbookRefSchema.parse`) |
| `scopeVars` | Event | `{ ...context.templateVars, ...context.variables }` (merged at fire time) |

The canonical implementation site is `compileMachineFromState` in `packages/core/src/runbook/actor-service.ts` (around line 145), where `flattenTemplateVars(state.templateVars)` and `evaluationOptions.cwd` are passed into `compileRunbookToMachine` and threaded into every per-state `invoke.input` closure.

---

## CLI ↔ Core Event Boundary

The CLI and core packages communicate through a typed event boundary. Two flows: events the CLI sends into the machine, and observable events the CLI renders by translating snapshot transitions.

### Events the CLI sends into the machine

| Event | Source | Notes |
|---|---|---|
| `PASS` / `FAIL` | `rd pass` / `rd fail` STDIN, substep-completion drain | Only from external user actions or pre-persisted completion records. The CLI MUST NOT synthesise these from internal observation. |
| `GOTO { target }` | `rd goto` | Jumps. `target` is a `StepId`. The CLI's `--index` flag is resolved before dispatch; the event itself carries no index field. |
| `RETRY` | (internal — generated by retry transitions) | |
| `SET_VARIABLES { vars }` | Delegation completion | Used when a child runbook reports back. |
| `PENDING_FRONTIER_CONSUMED` | Delegation issuance | Acknowledges the CLI consumed a pending frontier marker. |

The set is small and stable. New CLI subcommands dispatch into existing events; they do not introduce new events without a corresponding state-machine handler. Transitional events introduced during incremental migrations (e.g. an event that bridges a CLI-owned side effect to a machine-owned one before the side effect itself moves into the machine) are scoped to the migration window and removed once the boundary collapses — they do not become permanent fixtures of the protocol.

### Observable events the CLI renders

The CLI subscribes to actor state changes and translates them into observer events for stdout/stderr (and for the MCP server when it is the front end):

| Event | When |
|---|---|
| `STEP_ENTERED { stepId, ... }` | On entering a step state |
| `RUNBOOK_STOPPED { reason, message }` | Final state, lifecycle = `'stopped'`. `reason` is narrowed from a typed `lastAction` variant where applicable. Payload shape defined in `packages/core/src/events/types.ts`. |
| `RUNBOOK_COMPLETED` | Final state, lifecycle = `'completed'` |
| `ERROR_OCCURRED { code, message }` | When a typed `lastAction` variant indicates a machine-internal failure (e.g. `RETRY_ERROR`). See [Typed `lastAction` Discriminants](#typed-lastaction-discriminants). |
| `COMMAND_STARTED` / `COMMAND_COMPLETED` / `POLICY_DENIED` | Currently emitted directly by the CLI execution loop; will move into the machine when command execution becomes a Category C actor. |

The narrowing layer between snapshot context and observer events uses the typed `lastAction` discriminant convention — never `lastMessage` string parsing.

---

## XState Compiler

The compiler in `packages/core/src/runbook/compiler.ts` builds XState v5 machines from parsed Markdown. State IDs, transition targets, and per-step actions are determined at runtime, so XState's compile-time checks of state names and transition targets do not apply to the generated graph. This section captures the patterns that keep type safety where it matters despite dynamic generation. For generic XState v5 + TypeScript reference material, see [xstate-patterns.md](./xstate-patterns.md).

### Why dynamic compilation matters for type safety

The compiler builds machine configs from parsed Markdown:

- State IDs are computed strings (`"step::1::2"`, not literal types)
- Transition targets are computed — TypeScript cannot verify they exist
- The set of states and transitions changes per runbook

`setup({ types })` is still used for context/event typing, and that typing is enforced exactly as it is for a hand-authored machine. The dynamic part is the state graph layered on top.

### Where type safety matters: boundaries vs the generated graph

Focus type safety on **boundaries** and **stable operations**, not on the generated graph:

| Boundary | Status | Target pattern |
|----------|--------|----------------|
| `RunbookEvent` discriminated union | Strong | (already correct) |
| `RunbookContext` interface | Strong | (already correct) |
| `LastAction` discriminated union | Strong | (already correct) |
| `assign()` internals | Weak — `AssignAction = (...args: never[]) => unknown` erases context types | `runbookSetup.assign()` |
| State config shape | Weak — `TransitionEntry` uses `unknown` fields | `setup().createStateConfig()` |
| Stable per-step operations | Inline, untyped | Named actions in `setup()` with typed `params` |
| Snapshot persistence | Weak — `as any` casts in narrowing | Typed narrowing functions |

### Hybrid pattern: stable named actions + dynamic params

Even though the graph is dynamic, many operations are stable and repeat across generated states: reset retry counters, set `lastAction`, append pass/fail results, initialize/clear FOR context, set current substep.

Register these as named actions in `setup()` with typed `params`:

```typescript
const runbookSetup = setup({
  types: {} as { context: RunbookContext; events: RunbookEvent },
  actions: {
    setLastAction: assign({
      lastAction: (_, params: { action: LastAction }) => params.action,
      lastMessage: (_, params: { action: LastAction; msg?: string }) => params.msg,
    }),
    resetRetry: assign({
      retryCount: 0,
      iterationRetryCount: 0,
    }),
  },
});

// In the generator — compile-time checked:
actions: {
  type: 'setLastAction',
  params: { action: { type: 'CONTINUE' }, msg: undefined },
}
```

This gives compile-time check that the action exists, compile-time check that `params` matches the expected shape, and runtime flexibility for the dynamic state generation.

### Validated graph builder

For dynamic compilers, use a two-phase build:

1. Generate all state IDs first (single source of truth)
2. Resolve transition targets through a `toStateId(...)` resolver — never raw strings
3. Validate graph integrity before `createMachine()`:
   - **Target existence** — every `target` resolves to a generated state or a known terminal (`COMPLETE`, `STOPPED`). Fail fast: `"unknown target step::9::2 referenced from step::4::1 PASS"`.
   - **Uniqueness** — no duplicate state IDs were generated.
   - **Valid initial** — the computed `initial` state exists in the generated set.
   - **Semantic invariants** — e.g. `BREAK` must not appear in parent aggregation transitions; retry states must exist when `retry > 0`.
4. Only then emit XState state configs.

Optional hardening: brand `StateId` (`string & { __brand: 'StateId' }`) so raw string targets are a type error. Keep target resolution in one module so failures include source/target context.

### Migration priorities

1. **`runbookSetup.assign()`** instead of raw `assign()` — immediate type-safety win, no restructuring needed.
2. **Named stable actions in `setup()`** with typed `params` — hybrid pattern above.
3. **`createStateConfig()` wrapping** at insertion — validates each generated state config. Build incrementally as today, then pass through `runbookSetup.createStateConfig(...)` as the final step before inserting into `states`.
4. **Validated graph builder + target resolver API** — eliminate raw target strings during generation.
5. **Runtime graph validation** — catches what TypeScript cannot prove.
6. **Explicit return type** on `compileRunbookToMachine()`.
7. **Specialize `AnyActorRef`** with `ActorRefFrom<typeof machine>` in `actor-service.ts`.
8. **Reduce `as any`** in snapshot migration with typed narrowing functions.

---

## Retry Counters

Three counters track retry attempts. They are not interchangeable — unifying them breaks the retry-budget guards.

| Counter | Site A writes (parent-aggregation retry) | Site B writes (FOR-iteration retry) | Consumer | Purpose |
|---------|-------------------------------------------|--------------------------------------|----------|---------|
| `parentRetryCount` | increments by 1 | unchanged | parent retry-budget guard (`parentRetryCount < transition.retry`) | machine-invariant counter for the parent's `RETRY` budget |
| `iterationRetryCount` | resets to 0 | increments by 1 | FOR-iteration retry-budget guard | machine-invariant counter for the iteration's `RETRY` budget; reset on parent re-entry because re-entering the parent invalidates any in-progress iteration's budget |
| `retryCount` | increments by 1 | increments by 1 | actor-service / `rd echo --result` / state output | user-visible counter — surfaces total retry attempts regardless of layer |

**Why the split:** `parentRetryCount` and `iterationRetryCount` are budget guards — they must increment at exactly one site each so the corresponding guard exhausts predictably. `retryCount` is observability — every retry transition (at either site) advances it. Unifying machine-invariant counters with the user-visible counter would either prevent the parent budget from exhausting (if Site B did not increment) or double-count parent retries (if `parentRetryCount` were also bumped at Site B).

See `packages/core/src/runbook/compiler.ts` for the two assign sites.

---

## WebContainer Environment

In WebContainer environments (e.g., StackBlitz), nested process spawning may not work correctly. The CLI includes an internal command dispatcher (`packages/cli/src/services/internal-commands.ts`) that intercepts `rd`/`rundown` commands and executes them directly without spawning a child process.

- `isInternalRdCommand()` detects rd/rundown commands
- `executeRdCommandInternal()` dispatches to internal handlers
- Currently supported: `echo`, `prompt` commands
- Unsupported commands fall back to standard spawn behavior
