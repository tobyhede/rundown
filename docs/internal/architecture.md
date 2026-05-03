# Rundown Internal Architecture

This document describes Rundown's implementation architecture: the state machine design, core abstractions, design principles, and internal subsystems. For the CLI user reference, see [docs/reference/cli.md](../reference/cli.md). For the execution model and runtime semantics, see [docs/reference/runtime.md](../reference/runtime.md).

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

```
[Runbook File] --> [Parser] --> [XState Machine] --> [State Manager]
                                       ^                    |
                                       |                    v
                              [CLI Commands] <---- [Persisted JSON]
```

---

## Design Principles

**Type-driven dispatch:** The state machine uses types and events to drive logic. Steps raise typed events; parent states dispatch on event type via `on:` handlers. Guards should express domain conditions (e.g., "has more iterations") through typed helpers where practical, rather than open-coded action-string checks. When code does inspect a discriminant such as `lastAction.type`, it should narrow a purpose-built union and keep variant-specific fields behind that narrowing. Example: `LastAction` is a discriminated union whose variants encode transition context. The `GOTO` variant carries target information that other variants like `CONTINUE` or `DEFER` do not, so TypeScript prevents accessing it without narrowing first.

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

These input events are distinct from the action output recorded as `lastAction.type` after a transition resolves. The full `LastAction` union has nine variants: `START`, `CONTINUE`, `DEFER`, `GOTO`, `COMPLETE`, `STOP`, `RETRY`, `NEXT`, `BREAK` (see `packages/core/src/runbook/types.ts`).

### Transitions

Default transitions when none specified:
```
PASS ALL CONTINUE
FAIL ANY STOP
```

Transition evaluation:
1. Check condition (PASS or FAIL)
2. For RETRY: check if `retryCount < max`
3. Execute action (CONTINUE, COMPLETE, STOP, GOTO)

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
