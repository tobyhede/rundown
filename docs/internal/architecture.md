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
