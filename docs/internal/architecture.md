# Rundown Internal Architecture

This document describes Rundown's implementation architecture: the state machine
design, core abstractions, design principles, and internal subsystems. For the
CLI user reference, see [docs/reference/cli.md](../reference/cli.md). For the
execution model and runtime semantics, see
[docs/reference/runtime.md](../reference/runtime.md). For generic XState v5 +
TypeScript patterns, see [xstate-patterns.md](./xstate-patterns.md).

---

## Architecture Overview

The Rundown system separates concerns into these layers:

| Layer             | Component               | Responsibility                                                     |
| ----------------- | ----------------------- | ------------------------------------------------------------------ |
| **Format**        | `.runbook.md` files     | Runbook definition (steps, transitions, commands)                  |
| **State Machine** | XState-compiled machine | State transitions and guards                                       |
| **Persistence**   | One SQLite database     | Run state survives context clears                                  |
| **Concurrency**   | One writer per run      | The Owner Token names the writer; a version check refuses a race   |
| **Iteration**     | Machine-owned actors    | Per-iteration data source value resolution and machine transitions |

The CLI is an orchestration and control interface. Claude executes the actual
work.

```text
[Runbook File] --> [Parser] --> [XState Machine] --> [State Manager]
                                       ^                    |
                                       |                    v
                              [CLI Commands] <---> [.rundown/rundown.db]
                                                    (SQLite: one `runs` table)
```

Captured filesystem outputs are the one piece of run-adjacent state that is not
in the database: they stay under `.rundown/runs/<run-id>/outputs/`. See
[§ State Persistence and Concurrency](#state-persistence-and-concurrency).

---

## Design Principles

**Type-driven dispatch:** The state machine uses types and events to drive
logic. Steps raise typed events; parent states dispatch on event type via `on:`
handlers. Guards should express domain conditions (e.g., "has more iterations")
through typed helpers where practical, rather than open-coded action-string
checks. When code does inspect a discriminant such as `lastAction.type`, it
should narrow a purpose-built union and keep variant-specific fields behind that
narrowing. Example: `LastAction` is a discriminated union whose variants encode
transition context. The `GOTO` variant carries target information that other
variants like `CONTINUE` or `DEFER` do not, so TypeScript prevents accessing it
without narrowing first. See [§ XState Compiler](#xstate-compiler) for how this
principle is enforced through the hybrid named-action pattern.

**No silent mapping.** Actions like STOP, COMPLETE, BREAK must propagate as
themselves. Never silently convert one action type to another (e.g., mapping
DEFER to CONTINUE). Each action type has distinct semantics that must be
preserved through the entire dispatch chain.

**No synthetic IDs.** Don't create artificial state identifiers (like `~channel`
prefixes). Use XState's native event system and state graph structure.

### Typed `lastAction` discriminants

Machine-internal failures and step outcomes are signalled via the typed
`LastAction` discriminated union, never via string-prefixed `lastMessage`
parsing or other stringly-typed channels. The union is defined in
`packages/core/src/runbook/types.ts`. Its members are the transition-action
variants `START`, `CONTINUE`, `DEFER`, `GOTO`, `COMPLETE`, `STOP`, `RETRY`,
`NEXT`, `BREAK`; the policy variant `POLICY_DENIED`; and the
`InternalFailureLastAction` sub-union — `OUTPUT_CAPTURE_FAILED`,
`ARTIFACT_RESOLUTION_FAILED`, `FOR_RESOLUTION_FAILED`, and
`COMMAND_EXECUTION_FAILED`. (`lastMessage` itself remains a legitimate
diagnostic carrier for free-form context — what is forbidden is _type
discrimination_ via string parsing of it.)

Narrowing into observer events (`ERROR_OCCURRED`, `RUNBOOK_STOPPED { reason }`)
happens in **core**, not the CLI —
`packages/core/src/events/transition-observation.ts` builds those events from a
terminal snapshot. The internal-failure variants are handled collectively, not
per-variant:

- `isInternalFailureLastAction(lastAction)` — a single type guard that narrows
  any `LastAction` to the `InternalFailureLastAction` sub-union (defined in
  `packages/core/src/runbook/transition-kernel.ts`).
- `extractInternalFailureMessage(lastAction)` — pulls the diagnostic message off
  whichever internal-failure variant is present.
- `deriveStoppedReason(lastAction)` — maps a terminal `lastAction` to the
  `RUNBOOK_STOPPED` reason.

There is no per-variant extraction helper. New internal-failure variants are
added to the `InternalFailureLastAction` union and are then covered by the
existing guard and extractors without any new narrowing code. The CLI's
`transition-orchestrator.ts` consumes the already-built observer events; it does
not narrow `lastAction` itself.

---

## State Machine

The CLI compiles runbooks into an XState state machine. Each step (and substep)
becomes a state. Events (`PASS`, `FAIL`, `GOTO`, `RETRY`) trigger transitions.

### Compilation

Runbooks compile to XState machines at runtime. Steps become states:

| Runbook Element      | XState State ID         |
| -------------------- | ----------------------- |
| `## 1. Title`        | `step::1`               |
| `## 2. Title`        | `step::2`               |
| `### 2.1 Substep`    | `step::2::1`            |
| `## Cleanup`         | `step::Cleanup`         |
| `### Cleanup.verify` | `step::Cleanup::verify` |

Terminal states: `COMPLETE`, `STOPPED`

### Input Events

The state machine responds to these input events:

| Event   | Trigger                              | Effect                              |
| ------- | ------------------------------------ | ----------------------------------- |
| `PASS`  | `rundown pass` or command exit 0     | Evaluate PASS transition            |
| `FAIL`  | `rundown fail` or command exit non-0 | Evaluate FAIL transition            |
| `GOTO`  | `rundown goto N` or GOTO action      | Jump to step N                      |
| `RETRY` | FAIL + RETRY action                  | Increment retryCount, stay in state |

These input events are distinct from the action output recorded as
`lastAction.type` after a transition resolves. The transition-action
`LastAction` variants are `START`, `CONTINUE`, `DEFER`, `GOTO`, `COMPLETE`,
`STOP`, `RETRY`, `NEXT`, and `BREAK`. Beyond those, the union also carries
`POLICY_DENIED` and the `InternalFailureLastAction` sub-union
(`OUTPUT_CAPTURE_FAILED`, `ARTIFACT_RESOLUTION_FAILED`, `FOR_RESOLUTION_FAILED`,
`COMMAND_EXECUTION_FAILED`) — see `packages/core/src/runbook/types.ts` and
[§ Typed `lastAction` discriminants](#typed-lastaction-discriminants).

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

Each leaf step state in the compiled machine is a **compound state** with `idle`
plus compiler-owned transient children tagged `PENDING_MACHINE_EFFECT_TAG`.
Sibling states for retries (`::pass-retry`, `::fail-retry`) remain top-level as
before and self-target back to the leaf when the retry budget allows.

Sourced FOR leaves enter `__resolve-iteration` before any authored work runs.
That child invokes `forIterateActor`, which resolves the current loop value from
the initial template-variable seed supplied through the compile-time closure.
Its `onDone` has two typed branches: `event.output.kind === 'ready'` stores the
hydrated value in `context.forStack` and chains to `__resolve-artifacts` or
`idle`; `event.output.kind === 'exhausted'` caps the loop frame and targets the
typed `#iteration_exhausted` entry point. `onError` targets `#STOPPED` after
storing a `FOR_RESOLUTION_FAILED` lastAction.

FOR source resolution normalizes variable values into `IterableSource` before
dispatch. The accepted source variants are in-memory JSON arrays, JSONL file
streams, and ARTIFACTS wildcard record sets. This keeps ARTIFACT identity
separate from generic JSON while giving the machine one typed iteration
boundary.

Nested FOR support remains intentionally out of scope for this actor shape:
`forIterateActor` currently receives one top-of-stack `ForContext`. When nested
FOR is added, the actor input and compiler wiring must be revisited to pass and
resolve all active frames coherently.

Leaves with ARTIFACTS use `__resolve-artifacts` after iteration resolution. This
ordering means ARTIFACTS templates may reference the loop variable for the
current iteration.

After `__resolve-artifacts` (or `__resolve-iteration`, or directly) every leaf
rests in `idle`. A **composing runbook-list substep** passes through one more
child on that entry path: the transient `__reserve-child`, whose entry action
records the substep's Current Child on its `substepStates` entry and leaves for
`idle` in the same macrostep. It sits after iteration and ARTIFACTS resolution
so a child inherits the resolved iteration binding, and only the entry path
targets it, so the progression round-trips through `idle` never reserve again.
`entry` is the frame entry `syncFrameEntry` just made current; run ids come from
the compile-time `generateChildRunId` callable. A loop iteration, `GOTO` or
`RETRY` re-enters the leaf and reserves afresh, so an older reservation is stale
by construction.

- An **inline substep** (one runbook, no `DELEGATE`; #903) reserves
  `{ kind: 'inline', runId, entry, runbook }` (`reserveInlineChild`,
  `inline-child.ts`); the context its child inherits is read from the parent row
  at launch.
- A **delegated substep** (one runbook, `DELEGATE`; #904) reserves a
  `{ kind: 'delegation', runId, entry, runbook, contextSnapshot, ticketHash: null }`
  for itself and every later delegated substep of the step that has none at this
  entry (`reserveDelegationChildren`, `delegation-child.ts`), so a fan-out's
  children are all reserved when the first is entered. The snapshot is captured
  here, from machine context, because the child is claimed later by another
  agent and a sibling Collected in between must not leak into it. A reservation
  of an earlier entry that this one replaces has its Claim Ticket hash appended
  to the substep state's `replacedTicketHashes`, Collected or not, so its ticket
  is refused as no longer counted rather than unknown; a reservation never
  issued a ticket records nothing. Its child's commands need no record: the
  child is no longer among the active entry's reservations. The transient
  state's `always` also raises the substep's `PASS` / `FAIL` when its
  reservation was already Collected out of order (below).

Every composing leaf handles `CHILD_RESULT` in `idle` — Collect — for its own
Current Child (guarded on run id, active entry and not yet `collected`): it
merges the child's final variables (`storeCapturedVariables`), records the
reservation `collected` (`recordChildCollected`) and raises the substep's own
`PASS` or `FAIL`. Every leaf of a step that delegates also takes the result of a
**later** delegated substep's child of the same entry: it merges the variables
and records it `collected` without moving the cursor, and that substep's
`__reserve-child` raises it on arrival — so a fan-out's results are applied in
any order and still drive the authored handlers in document order. A child for a
substep the cursor has passed matches no guard. `ISSUE_CLAIM_TICKETS` is a
machine-root handler: it records the ticket hashes Run Progression minted, all
or nothing, on reservations of the active entry that have none
(`recordClaimTickets`). Every leaf of a step that delegates also handles
`RETRY_DELEGATION { substepId, ticketHash }` in `idle` (#905): guarded on the
named substep's Delegation of the active entry still counting
(`retryableDelegation`), its assign cancels it and reserves a fresh child at the
same entry under a newly minted run id, carrying the event's ticket hash and the
cancelled reservation's runbook and context snapshot (`replaceDelegation`), and
records the cancelled one's ticket hash in `replacedTicketHashes`. `ABANDON` is
a machine-root handler targeting the `ABANDONED` final state, which assigns
`lifecycle: 'abandoned'` and stores no frontmatter outputs. It clears
`lastAction` and `lastMessage`: abandoning is neither a RESULT nor a handler's
ACTION, so no action type describes it, and mapping it to `STOP` would be a
silent mapping.

Two further children serve the machine-selected Run Progression turn:
`__progression-waiting-input` emits the typed `waiting` intent and
`__progression-enter-unit` invokes `runProgressionEntryActor` to render the
unit's entry (`entered`), or emits the retryable `entry_render_failed` refusal
when that render throws. Both route back to `idle`.

The leaf also invokes `commandExecActor` directly to execute the step's command;
that actor's completion produces the `COMMAND_RESULT` event the capture flow
consumes (see [§ CLI ↔ Core Event Boundary](#cli--core-event-boundary)).

### Frame entry ownership

The XState machine is the single writer of frame entry.
`RunbookContext.frameEntry` holds
`{ activeFrameKey, activeEntry, frameEntryCounts }` and is advanced by
`syncFrameEntry`, an `assign` appended after the existing entry actions on every
step/substep **leaf** state. `deriveActorStatePatch` mirrors the result into
`RunbookState.activeEntry` / `frameEntryCounts`.

Two ordering facts make the placement correct:

- **After `initForStack`.** FOR-stack initialisation lives in the same
  entry-action slot, so appending puts the sync after the iteration is current.
  A FOR loop-back therefore reads as a frame switch with no extra wiring.
- **Before the leaf's invoked children.** A compound state's `entry` assign runs
  before its initial child's `invoke` input factory is read, so any side-effect
  child that reads `context.frameEntry` sees the advanced value.

`syncFrameEntry` is **not** attached to `step::N::__parent-entry::M`: each is a
same-frame artifact pass-through that routes on to the real leaf, and bumping
there would double-count.

The bump rule lives in `advanceFrameEntry` (`frame-entry.ts`) and the frame-key
derivation in `frameKeyForCursor` (`targeting.ts`), the single derivation. Every
cursor-keyed site routes through it: `deriveActiveFrame`,
`deriveActorStatePatch`, `syncFrameEntry`, `buildSubstepGotoResetAssignValue`,
and the two inline `advanceFrameEntry` calls on the parent-retry transitions,
whose substep reset is keyed on the same answer. The rule it replaced filtered
`implicit` but never compared `stepId`; the two answers coincide for every stack
`initForStack` can build today, so the guard is a construction rather than a
live repair, and `targeting.test.ts` pins both the consumers and the absence of
any fourth rewrite. The entry ordinal is run-global and monotonic —
`max(frameEntryCounts[target] ?? 0, previousActiveEntry) + 1` — not
per-frame-local; entry identity across re-entries depends on that form.

**Re-entry is declared, not inferred.** Every transition that writes a `GOTO` or
`RETRY` `lastAction` also writes the one-shot `context.frameReentry` marker,
which the first following `syncFrameEntry` consumes and clears. The split is
deliberate: a transition knows _that_ it re-enters but not yet _which_ frame
(the FOR iteration is only current after the leaf's `initForStack` runs), and
one transition can drive several state entries — `__parent-entry::` routing is
two — which a one-shot marker survives and a `lastAction` read does not.

**Self-targeting transitions declare `reenter: true`.** A GOTO onto the leaf the
cursor already occupies, and a RETRY on a step with no parent `ARTIFACTS` to
route through, both target their own source. XState v5 defaults `reenter` to
`false`, and for such a transition `getTransitionDomain` returns the source, so
`computeEntrySet` never adds it and the source's `entry` array does not run —
while `addDescendantStatesToEnter` still re-enters the leaf's children. Left
alone that skips `syncFrameEntry` on a genuine re-entry (the transition resets
the frame's substep rows, increments `retryCount` and re-fires the leaf's entry
children) and leaks the one-shot marker onto the _next_ state entry, which then
bumps a within-frame advance. `selfTargetReentry` in `compiler.ts` attaches
`reenter: true` wherever the routed target equals the source id, and only there
— for a distinct target the domain is already the least common ancestor and the
flag would be inert. The parent-aggregation retry also self-targets and is
deliberately excluded: it carries no entry actions and relies on the assign
settling before a sibling priority-0 `always` routes onward.

**A self-targeting `GOTO` is bounded in the machine.** `GOTO <self>` is bounded
re-execution, not an infinite loop:
`GOTO SELF == GOTO SELF, MAX_SELF_GOTO_PASSES times, then STOP`, where
`MAX_SELF_GOTO_PASSES` is `MAX_FOR_BOUND` — a self-loop and a fully unrolled
`FOR` share one notion of how many passes Rundown will run. The shape is the
RETRY shape (`buildRetryStateConfig`): a first, guarded transition carries the
jump while `context.retryCount < MAX_SELF_GOTO_PASSES`, and a lower-priority
sibling carries the exhausted case. XState takes the first array entry whose
guard passes, so the jump is unreachable once the counter is spent and the STOP
is unreachable until it is. The exhausted entry is built by
`buildTerminalTransition('STOPPED', 'STOP', …)` — the builder the `STOP` action
itself compiles to — so exhaustion terminates through the existing STOP dispatch
rather than a parallel terminal path, and carries a `lastMessage` naming the
bound. `gotoReentersOwnUnit` is the single source of truth for "is this a
self-target": the guard reads the counter that only a self-targeting `GOTO`
increments, so a second copy of the rule would either bound a loop that never
counts or leave a counting loop unbounded. The bound applies to all three sites
that increment on a self-GOTO — the authored action on a substep-bearing target,
the authored action on a simple target, and the dispatched `GOTO` event on a
leaf — because the limit belongs to the action, not to who dispatched it.

**The loop counter is its own counter.** `context.selfGotoCount` counts
self-GOTO passes; `context.retryCount` is the author's `RETRY <count> <action>`
budget. They were one field, and each construct then spent the other's budget:
two self-GOTO passes exhausted an authored `RETRY 2` before its first failure,
and an authored retry ate into the loop bound. Both are unit-scoped, so
`selfGotoCount` is zeroed at exactly the sites that zero `retryCount` — every
`GOTO` (including a self-target, which reopens the unit from the top and so
restores the author's full retry budget), every parent exit, every FOR loop-back
and exit, and the initial context. RETRY leaves it untouched in both directions:
a retry re-enters the same unit without taking a loop pass. `compiler.test.ts`
("loop-counter reset sites") drives one test per site;
`self-goto-counter.source-text.test.ts` asserts the pairing structurally so a
site added later cannot ship unpaired.

**Entry ordinals are not FOR bounds.** `RunbookState.activeEntry` and every
value in `frameEntryCounts` are run-global monotonic ordinals. They were capped
at `MAX_FOR_BOUND` — the largest iteration count one `FOR` clause may declare —
which made this bound unobservable through persisted state: the ordinal starts
at 1 and bumps once per pass, so the last admitted pass reaches 10001, one past
the cap, and the run committed state its own next read refused. `schemas.ts`
validates both entry ordinals — `activeEntry` and `frameEntryCounts` — as safe
integers with no domain ceiling.

**The two parent-retry sites are the exception.** The parent-aggregation retry
and the FOR-iteration retry run as transition `assign`s, and transition actions
run before the target's entry actions, so `syncFrameEntry` cannot serve them.
Both sites call `advanceFrameEntry` inline, reset the frame's substep rows with
`resetReopenedSubsteps` keyed on the same frame, and deliberately set no marker
— the entry action that follows is then a no-op for that frame. On a FOR parent
the frame they advance is the **bare step frame**, not the iteration frame: the
loop has exhausted by the time the parent aggregation resolves, so
`frameKeyForCursor` finds no active FOR context. The parent-aggregation site
then assigns `forStack: EMPTY_FOR_STACK`, and the leaf `initForStack` that
follows rebuilds the loop at `forClause.start` — a second, genuinely different
frame, scored once by the entry action.

### Command execution and output capture

Command execution is a machine-owned Category C side effect. The command actor
can produce authored runbook outcomes (`pass` and `fail`) or command
infrastructure terminal reasons such as `POLICY_DENIED` and
`COMMAND_EXECUTION_FAILED`.

On `COMMAND_RESULT` the leaf transitions to its relative child
(`target: '.__capture'`). `__capture` invokes `outputCaptureActor`; its `input`
carries `{ channels, result }` read from the entering event. The actor reads
channel files into `variables` and returns `{ variables, result }` — `result` is
opaque to the actor and passes through unchanged. `onDone` merges
`event.output.variables` into context and `raise`s `{ type: 'PASS' | 'FAIL' }`
with **no `target`**; the raised event bubbles up XState's active state chain to
the leaf's own `PASS`/`FAIL` handler. `onError` targets `#STOPPED`.

Because the leaf stays active throughout the capture cycle, `entryActions`
(notably FOR-first-substep `initForStack`) are never re-run by capture. No
context field stores the result discriminant — it lives in the actor's typed
output and bubbles out as a typed event.

The pattern composes for additional side-effect children: each child owns one
actor source, one error path, and its own `onDone` shape. Children are chained
by initial-state choice and `onDone.target`; distinct actor outputs are not
collapsed into one shared context discriminant.

### Actor input wiring

A side-effect-bearing transient invokes a Category B or C actor (see
[`CLAUDE.md` § Side-effect categorisation](../../CLAUDE.md#side-effect-categorisation)).
The actor's `input` is assembled from two sources:

- **Compile-time-bound** dependencies are captured by the per-state
  `invoke.input` builder closure constructed inside `compileRunbookToMachine`.
  Examples: process state (`cwd`), service references (`RunbookStateManager`),
  parser-derived data (declarations attached to the step or substep), DI'd
  callables (a policy evaluator, a helper registry).
- **Event-time-bound** dependencies are read from `context` inside the
  `invoke.input` factory function at fire time. Examples: the current `runId`,
  captured variables, substep state, the result of a preceding command.

The wiring rule that makes this load-bearing is stricter than just "split the
wiring":

> **Persisted context contains only data; runtime references flow through
> invoke-input closures.**

Three constraints back this up. `getPersistedSnapshot()` JSON-serialises
context, so function references cannot be persisted at all. Even values that
_can_ serialise — a path string like `cwd` — may be process-runtime state that
differs between the process that wrote the snapshot and the process that reads
it; persisting them would silently produce wrong behaviour after a process
boundary. And service instance references (a `RunbookStateManager`, a registry)
become stale across process boundaries even when they marshal — the new process
needs its own instance. The compile-time / event-time split routes each
dependency through the right boundary so none of these failures can happen by
accident.

Worked example — ARTIFACTS resolution (`::__resolve-artifacts` substate):

| Resolver field | Bound   | Source                                                                                                                                                                       |
| -------------- | ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `cwd`          | Compile | `evaluationOptions.cwd` (closure-bound)                                                                                                                                      |
| `declarations` | Compile | `step.artifacts` / `substep.artifacts` (closure-bound to the per-state factory)                                                                                              |
| `workPath`     | Event   | `context.templateVars.WorkPath` (read in factory)                                                                                                                            |
| `contextId`    | Event   | `context.templateVars.ContextId` (read in factory)                                                                                                                           |
| `runId`        | Event   | `context.templateVars.RunId` (read in factory; branded with `assertRunId`)                                                                                                   |
| `runbook`      | Event   | `context.templateVars.RunbookRef` (read in factory; validated with `RunbookRefSchema.safeParse` via the `requireRunbookRef` helper, which throws a wrapped error on failure) |
| `scopeVars`    | Event   | `mergeEffectiveVars({ templateVars, variables })` with the `buildArtifactRuntimeScope` overlay layered on top (FOR-loop `Step`, `Index`, loop variable, `context.current.*`) |

The canonical implementation site is `compileMachineFromState` in
`packages/core/src/runbook/actor-service.ts`, where
`flattenTemplateVars(state.templateVars)` and `evaluationOptions.cwd` are passed
into `compileRunbookToMachine` and threaded into every per-state `invoke.input`
closure. FOR iteration resolution additionally receives the unflattened initial
template-variable seed through the same compile-time closure so file-backed
`JsonArrayStream` sources never need to live in persisted XState context.

---

## CLI ↔ Core Event Boundary

The CLI and core packages communicate through a typed event boundary. Two flows:
events the CLI sends into the machine, and observable events the CLI renders by
translating snapshot transitions.

### Events the CLI sends into the machine

| Event             | Source                                      | Notes                                                                                                                                               |
| ----------------- | ------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PASS` / `FAIL`   | `rundown pass` / `rundown fail`             | Only from external user actions, sent by the lifecycle seam after `--step` validation. The CLI MUST NOT synthesise these from internal observation. |
| `GOTO { target }` | `rundown goto`                              | Jumps. `target` is a `StepId`. The CLI's `--index` flag is resolved before dispatch; the event itself carries no index field.                       |
| `RETRY`           | (internal — generated by retry transitions) |                                                                                                                                                     |

**It is not the whole `RunbookEvent` union.** `FORCE_STOP` and `FORCE_COMPLETE`
are sent by the lifecycle command seam for `rundown stop` / `rundown complete`;
`SELECT_RUN_PROGRESSION` and `EXECUTE_COMMAND` are sent by Run Progression;
`COMMAND_RESULT` comes from the compiled machine's own command actor;
`CHILD_RESULT` is sent by Run Progression (an Inline Child's implicit Collect)
and by the lifecycle seam's `runCollect` (`rundown collect`);
`ISSUE_CLAIM_TICKETS` is sent by Run Progression; `RETRY_DELEGATION` by the
lifecycle seam's `runRetry` (`rundown retry`); `ABANDON` by `releaseDelegation`
(`rundown release`); and `SET_VARIABLES` has a machine handler but no front-end
sender. None of them appear above. `packages/core/src/runbook/compiler.ts`
remains the authority on the union.

The rule new work must satisfy is the direction of the arrow: a new CLI
subcommand dispatches into existing events, and any new event arrives with its
corresponding state-machine handler rather than as a protocol extension a front
end can drive. Transitional events introduced during incremental migrations
(e.g. an event that bridges a CLI-owned side effect to a machine-owned one
before the side effect itself moves into the machine) are scoped to the
migration window and removed once the boundary collapses — they do not become
permanent fixtures of the protocol.

### Observable events the CLI renders

The CLI subscribes to actor state changes and translates them into observer
events for stdout/stderr (and for the MCP server when it is the front end):

| Event                                                     | When                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `STEP_ENTERED { stepId, ... }`                            | On entering a step state                                                                                                                                                                                                                                                                                                                                                                                                             |
| `RUNBOOK_STOPPED { reason, message }`                     | Final state, lifecycle = `'stopped'`. `reason` is narrowed from a typed `lastAction` variant where applicable. Payload shape defined in `packages/core/src/events/types.ts`.                                                                                                                                                                                                                                                         |
| `RUNBOOK_COMPLETED`                                       | Final state, lifecycle = `'completed'`                                                                                                                                                                                                                                                                                                                                                                                               |
| `ERROR_OCCURRED { code, message }`                        | When a typed `lastAction` variant indicates a machine-internal failure (e.g. `COMMAND_EXECUTION_FAILED`). See [Typed `lastAction` Discriminants](#typed-lastaction-discriminants).                                                                                                                                                                                                                                                   |
| `COMMAND_STARTED` / `COMMAND_COMPLETED` / `POLICY_DENIED` | Machine-owned. Command execution is the Category C actor `commandExecActor` (`packages/core/src/runbook/actors/command-exec-actor.ts`), wired into every leaf in `compiler.ts`. These observations flow through the `MachineExecutionObserver` effect collector in core (`packages/core/src/events/execution-observation.ts`); the CLI supplies the `runExternalCommand` services that the actor calls but does not emit the events. |

`STEP_ENTERED` is built by exactly one function, `deriveExecutionUnitEntry`
(`packages/core/src/runbook/execution-unit-entry.ts`), reached through
`RunbookActorService.enterExecutionUnit`. Every frontend enters a unit that way
through Run Progression's machine-owned entry states, so the payload cannot vary
with the command that produced it. The seam also classifies the entry, returning
`awaiting` / `runnable` / `inline_child` / `delegation`; the rendered command
travels only on the `runnable` arm, inside a nominally branded record the module
is the sole producer of; the `inline_child` arm carries the substep's current
reservation (`currentInlineReservation`), and the `delegation` arm the
Delegations the entry counts. Run Progression adds `children` — with each Claim
Ticket it issued in that turn — to a delegation entry's `STEP_ENTERED`.
`rundown collect` emits `CHILDREN_COLLECTED { children }` through the run's
emitter before the transitions its Collect observed.

The narrowing layer between snapshot context and observer events uses the typed
`lastAction` discriminant convention — never `lastMessage` string parsing.

---

## Lifecycle Command Seam

The owner's lifecycle commands — `rundown pass` / `rundown fail`,
`rundown complete` / `rundown stop`, and `rundown goto` — enter core through one
seam: `RunbookLifecycleCommandService`
(`packages/core/src/runbook/lifecycle-command-service.ts`). The seam, not the
CLI, owns the runbook logic; the CLI is a thin front end that resolves the
caller's Owner Token, hands the seam the run it owns, and renders what comes
back. The seam does no target resolution and no authority check of its own:
under one writer per run ([ADR 0005](../adr/0005-one-writer-per-run.md)) the
Owner Token is the only authority, and it is verified before the run reaches the
seam.

### Ownership is resolved once, by token

`resolveOwnedRun(manager, token)` (`run-authority.ts`) is the sole authority
lookup behind every mutating command. It hashes the token (`hashRunSecret`),
looks the hash up with `findByOwnerTokenHash`, and returns one of three answers:
`running` with an `OwnedRun` — the state **and the `state_version` it was read
at**; `finished` with the lifecycle the run reached (`completed`, `stopped`,
`abandoned`), which the CLI renders as RD-303 / RD-304; or `unknown_token`. A
run id is never authority; `--run` is a read-only selector on `status` and
nothing else — except the human escape hatch below. The plaintext token appears
in exactly one place, the `runbook_started` event, and never in a message, a
row, or a refusal.

The same module holds `findUnsupportedComposition(steps)`, the decision behind
`RUNBOOK_COMPOSITION_UNSUPPORTED`. `RunbookStateManager.create`,
`createInlineChild` and `claimDelegationChild` apply it before writing a row,
throwing `RunbookCompositionUnsupportedError` for a runbook with a substep
listing more than one runbook. Every front end that creates a run, every inline
launch and every claim is refused the same way; the CLI only renders the ids
core names, and `rundown check` warns from the same predicate.

Before descending, `resolveCommandTarget` checks the token's run's standing as a
Delegation (`delegationStandingOf`, `delegation-progression.ts`): a delegated
child whose parent finished or was pruned (its linkage reads
`orphaned_delegation`) is refused `parent_run_finished`, and one its parent no
longer counts (by `countsDelegation`: reserved at the parent's active entry, not
yet Collected, for the cursor's substep or a later one; a retried or re-entered
child is no longer reserved there at all) is refused `delegation_cancelled`.
Every other run is `current`. The check is skipped for `stop` alone (the caller
names its command, `CommandTargetPurpose`): the child's owner owns the child's
row and may end it, though nothing collects its result.

### The command's target: the deepest running Inline Child

A mutating command does not act on the token's run directly.
`RunbookLifecycleCommandService.resolveCommandTarget(token, settle)` resolves
the token to its root with `resolveOwnedRun`, then descends: while the run's
cursor rests on an inline substep whose Current Child row exists and is running,
it moves to that child. The deepest running run is the target, so `--step` then
names a step of the child, and an `invalid_step_target` against an inline child
names the child and its parent. If the descent finds a Current Child that is
**terminal** — its parent's command died before the implicit Collect — it calls
the frontend's `settle` callable (the CLI's standard Run Progression activation)
on that parent first, with the `collect_inline_child` entry boundary: the
activation commits only the Collect — no command turn, no launch, no ascent —
and then the descent starts again from the root, one level per pass up an
uncollected chain. The owner's command applies at the resulting position; a
`pass` on a command step the Collect left owed is refused `EXECUTION_PENDING`. A
Collect that could not land refuses the command as `settle_refused`, unless the
run no longer owes it (another command moved it), which leaves a target to act
on. The descent never follows a stale child: only the reservation of the active
frame entry counts.

### What the seam does

Every method takes an `OwnedRun` and returns typed outcomes as **data**. The
seam does not spawn processes, render, or retry.

- `runTransition({ command, run, target, computeActionResult? })` — refuse a
  finished run (`run_finished`); confirm `--step` / `--index` against the
  current position with `resolveTransitionCursor` (`invalid_step_target`,
  nothing written); derive the machine transition for `PASS` / `FAIL` with
  `RunbookActorService.prepareActorMutation`; commit it with **one** conditional
  `manager.save(nextState, run.stateVersion)`; derive the observation
  (`deriveTransitionObservation` reconciled against the committed lifecycle) and
  return `applied { status, events, progression, updatedState? }`. A substep
  completion is the same `PASS` / `FAIL` sent to the single live leaf; there is
  no completion mailbox.
- `runTerminal({ command, run, message? })` — the same shape for
  `FORCE_COMPLETE` / `FORCE_STOP`, returning
  `applied { lifecycle, events, progression }`. `progression` is core's answer
  to whether composition owes a further turn
  (`progressionDirectiveForTerminalRun`): `activate` at the observed terminal
  when the run is an Inline Child, so its parent Collects it; otherwise `none`.
- `resolveRunNavigation({ run })` → `allowed` with an opaque
  `LifecycleNavigationCapability` binding authority, graph and the versioned
  state together; `runNavigationMutation({ navigation, target })` applies the
  `GOTO` under that version.

Two refusals are shared by every method. `run_finished` carries the lifecycle
and the run id. `concurrent_modification` means the row's `state_version` moved
between the owner's read and this save: nothing was written, the persisted state
is intact, and the seam does not retry — under one writer per run the only
concurrent writer is the owner's own second command, and a loop here would let
it land silently behind the first. The CLI renders it as
`CONCURRENT_MODIFICATION`; the operator re-reads the run and re-issues the
command.

### The `--step` contract

`resolveTransitionCursor(steps, state, target)` (`transition-cursor.ts`) is pure
and is the whole of the `--step` / `--index` contract. The machine is in exactly
one leaf, so `--step` is a confirmation of the current position, not a selector.
In order: `--step` is required; the id must parse and may not carry a template
AT expression; it must name the active step; at a substep it must name **that**
substep (a bare step id is refused), while at a top-level step with no active
substep the bare id is accepted and a substep-qualified id is refused; inside a
FOR iteration `--index` (or the AT slot of a three-level id) is required and
must name the current iteration, and outside one any index is refused. Every
refusal names the current position (`the current position is 2.1`) so the next
command can be written from the message alone, and every refusal happens before
any write. The CLI composes none of these messages; it passes
`target: undefined` when `--step` is absent and renders `invalid_step_target` as
`INVALID_STEP`.

### Run Progression after the seam

`applied` carries a `RunProgressionDirective`. The CLI renders the seam's
events, then activates `activateRunProgression(authority, deps, entryBoundary)`
verbatim. The activation loads the run **with its version**, asks the restored
compiled machine for the next intent (`SELECT_RUN_PROGRESSION` → `waiting` or
`entered`), and for a runnable unit commits exactly one `EXECUTE_COMMAND` turn
through `commitRunProgressionEvent`: `prepareActorMutation` then one conditional
save under the version the turn read. A moved version is the
`command_not_committed` refusal (`CONCURRENT_MODIFICATION`, retryable) — the
command ran, its result was not recorded, and the activation says so rather than
retrying over whoever wrote. Observation delivery is still the commit gate
(#853): each commit's observations are delivered synchronously before the next
effect, and a throwing sink ends the activation with the `failed` outcome. The
entry boundary minted by the seam (`after_observed_transition`) keeps the
activation from re-announcing a terminal the seam already rendered.

The command callable stays a Category-C dependency injected into
`RunbookActorService` (`commandServices`) and reaches the machine through
`compileRunbookToMachine`; the activation itself takes
`{ manager, actorService, loadSteps, sink }` plus, for composition, the
frontend's `prepareChildRun` and a per-run `sinkFor`.

### Inline Children in Run Progression

An `inline_child` entry makes the activation drive a second run
(`driveInlineChild`, `run-progression.ts`; launch helpers in
`inline-progression.ts`):

- **Launch.** If no row carries the reserved id, the parent's unit entry is
  announced (once, here), the frontend's `PrepareChildRun` prepares the child
  runbook from the reservation (Category C: discovery, file IO, variable
  resolution under policy, inheriting the context snapshot), and core creates
  the row with `RunbookStateManager.createInlineChild` — inline linkage, no
  Owner Token hash — initialises its machine and emits its `RUNBOOK_STARTED` (no
  token) through the child's own sink. A refused preparation, a child with a
  substep listing more than one runbook, or nesting past
  `MAX_INLINE_CHILD_DEPTH` (32) is the `inline_child_launch_failed` refusal; the
  parent rests on the substep.
- **Descend.** While the child runs, the activation drives it with its own
  authority (minted in core: the parent's token authorizes it), recursively. A
  child that waits or refuses ends the activation where it rests.
- **Collect.** Once the child is terminal, the parent commits one `CHILD_RESULT`
  (`childResultEvent`: the Child Result read from the child's row and its
  `finalVars`) through `commitRunProgressionEvent` at the version the parent was
  read at, reports the parent's transition, and continues the parent's loop.
- **Ascend.** An activation that started on an Inline Child (after the owner's
  `pass` on its last step, say) does not stop at the child's terminal:
  `driveProgression` drives the parent that still counts it
  (`inlineParentCounting`), whose inline entry finds the terminal child and
  Collects it, level by level up the chain.

Both rows are written only by the parent owner's command; the child never writes
its parent. The parent holds no execution lease while its child runs — the
child's command turns lease the child row — and the Collect is the parent's own
conditional write.

### Delegations: tickets, claim, Collect, retry and release

A `delegation` entry never runs a command and never drives its child: the child
belongs to whichever agent claims it.

- **Tickets.** The turn that announces a delegation entry mints a Claim Ticket
  for every counted reservation with a null `ticketHash` (`issueClaimTickets`,
  `delegation-tickets.ts`), commits only their hashes as `ISSUE_CLAIM_TICKETS`
  with one conditional save (a moved version refuses the turn
  `claim_tickets_not_issued`, `CONCURRENT_MODIFICATION`), and emits the entry's
  `STEP_ENTERED` with `children` carrying the plaintext tickets. An entry
  announced again lists the children without tickets. Then the turn waits. A
  parent resting on a delegated substep that still owes a ticket
  (`owesClaimTickets`, `delegation-child.ts`) is activated again by the owner's
  `collect`, whose activation re-enters the unit and issues them.
- **Claim.** `claimDelegation` (`delegation-progression.ts`) reads only the runs
  whose `state_json` records the ticket's hash (`findByTicketHash`), finds the
  reservation whose `ticketHash` the ticket hashes to, checks its standing on
  the parent, prepares the child runbook through the same `PrepareChildRun`
  frontend service an Inline Child's launch uses (`child-preparation.ts`), mints
  the child's Owner Token, and calls `RunbookStateManager.claimDelegationChild`:
  one transaction that re-reads the parent, re-runs the standing check on it,
  and inserts the initialised child row under the reserved id with delegation
  linkage and the claiming agent. The primary key refuses a second claim
  `already_claimed`. The CLI then emits the child's `RUNBOOK_STARTED` with its
  token and drives the child's first activation, as `rundown run` does.
- **Collect.** `RunbookLifecycleCommandService.runCollect` →
  `collectDelegations` reads the active entry's Delegations in document order;
  for each terminal child the parent still counts it derives one `CHILD_RESULT`
  and commits it with one conditional save, re-reading the version between
  saves. Only a Collect that moved the cursor returns an `activate` directive
  (`after_observed_transition`), so the frontend's activation announces the next
  unit — with its own tickets, if it delegates — or, for an Inline Child that
  delegates and just finished, ascends into its parent.
- **Retry.** `RunbookLifecycleCommandService.runRetry` → `retryDelegation`
  (`delegation-recovery.ts`, #905) refuses under the execution lease, confirms
  `--step` / `--index` with `resolveRetryTarget` (`transition-cursor.ts`: any
  substep of the current step, at the current iteration), refuses a substep with
  no counted Delegation `NOTHING_TO_RETRY`, mints the new Claim Ticket, and
  commits `RETRY_DELEGATION` carrying its hash with one conditional save. The
  plaintext is returned once for the CLI's `DELEGATION_RETRIED` event. The
  parent never writes the cancelled child: its next command reads its standing.
- **Release.** `releaseDelegation` (`delegation-recovery.ts`, #905) is the one
  write not authorized by an Owner Token. It loads the child by id, requires a
  Delegation linkage (live or orphaned) whose `claimedBy` equals the presented
  agent id (both absent match), and refuses a finished child. The running Inline
  Children the child composes (its Current Inline Child, transitively) share its
  authority and would be unreachable once it ends, so each takes `ABANDON` with
  it: the lease rule applies to every one, and `RunbookStateManager.saveRuns`
  commits them all in one transaction that compares every row's version before
  writing any. It never reads the parent for writing; after the commit it reads
  the parent once to report the child's standing (`delegationStandingOf`), so
  the event says truthfully whether the parent's Collect will read `abandoned`
  as FAIL. The CLI renders the committed state the outcome carries and never
  re-reads the child.

### Prune: one rule for every pruning caller

Which runs a prune deletes is decided in core by `planPrune` (`run-pruning.ts`,
#906) over one listing (`listWithVersion`); `rundown prune` lists the store,
renders the plan and makes its deletes. In order:

- **Current Child protection.** `childProtection` decides, over the listing,
  which running parent still counts a child: an Inline Child while its parent's
  `currentInlineReservation` names it (the predicate the parent's progression
  launches and Collects by), a Delegation while `delegationStanding` reads it
  `current`. Each parent's graph is parsed once per listing; a parent whose
  runbook cannot be parsed leaves its Delegations `undetermined`, retained
  `"parent unreadable"` (and `--token` naming one refused), rather than aborting
  the prune. A protected child is never deleted on its own, whatever its
  lifecycle — `retained: "uncollected"` once terminal, `"current child"` while
  running — and `--token` naming one is refused `CURRENT_CHILD_PROTECTED`.
  Collect, Cancellation, the parent's terminal and the parent's prune each end
  it. Ending it deletes nothing by itself, except within the prune that deletes
  the parent: a terminal child the prune's own selection picks is planned after
  the parent's delete, and a running one is retained `"child run"`. Protection
  is read from one listing and only ever ends (a replaced reservation is never
  counted again, a finished parent never runs), so a planned delete cannot
  become wrong before it lands.
- **Running runs.** A running top-level run no token names is deleted only when
  the frontend's `confirmRunning` callable — a human at an interactive terminal,
  Category A — confirms its delete, asked only after the lease rule passes its
  chain. The callable returns the `HumanConfirmationAudit`, which the planned
  delete carries (`confirmedBy`) for the front end to report, since the row it
  would be recorded on is deleted. A running Child Run is never offered, the
  same restriction as the escape hatch: it is retained `"child run"` with
  `childRunRemedy`'s recoveries.
- **Deletes.** `planRunDeletions` folds each selected run's Inline Children into
  its root's delete (`run-deletion.ts`), and `refuseDeletionUnderLease` applies
  the lease rule to the whole chain, once per delete: a refusal of the owned run
  refuses the prune before anyone is asked; any other is retained. A run a
  delete removes with its root is reported deleted, never retained. Each delete
  is one `deleteAtVersion` naming every row at the version it was read at.

### The human escape hatch

`rundown stop --run <run-id>` (#906) is the one mutation a run id drives. The
CLI decides that a human is at an interactive terminal and asks them
(`helpers/escape-hatch.ts`, through the injected `HumanConfirmation`, which
reads end of input and Ctrl-C as no); core decides the rest (`human-stop.ts`).
`resolveHumanStopTarget` refuses, before anyone is asked, an id that names no
run, a finished run, a Child Run (`NOT_A_TOP_LEVEL_RUN`, with `childRunRemedy`'s
recoveries: an Inline Child's remedy names the run at the top of its inline
chain), and an attempt In Progress on the run or any running Inline Child it
composes (`runningInlineChain`, shared with `release`). It otherwise returns the
run and that chain, each with the version it was read at. After a yes,
`stopByHuman` derives each run's `FORCE_STOP` through its own machine and
commits them in one `saveRuns` write at those versions, the root's state
carrying the `HumanStopAudit` (`at`, `user`, `host`, `message`) as
`RunbookState.humanStop`; a version that moved refuses the whole stop. The
Inline Children stop with the root because the lost token was their only
authority. MCP has no tool for it.

### Guards do no cross-run IO or policy

No machine guard reads another run. XState guards express per-run domain
conditions — the `CHILD_RESULT` guard compares the event's child id with the
reservation in the machine's own context; ownership, the inline descent,
`--step` confirmation and the version check all happen at the seam and
activation boundaries, which read child rows from the store. That is what lets
the state machine remain a pure per-run program.

### Lifecycle write diagnostics

Every persisted write that changes `RunbookState.lifecycle` — and every
run-state deletion — emits a `logger.debug('lifecycle-write', …)` line from the
two persistence chokepoints, `RunbookStateManager.save` (every commit, and
creation as `running`) and `RunbookStateManager.delete`. The lifecycle seam, Run
Progression and actor snapshot sync all funnel through `save`, so every writer
is covered regardless of caller. Enable with `RUNDOWN_LOG_LEVEL=debug`; the
logger stamps pid.

The delete trail is emitted after the row delete commits and **before** the
per-run outputs directory is removed, so a later `fs.rm` failure cannot suppress
the record of a deletion that actually happened.

This is deliberately a debug signal, not a durable subsystem: the forensic
instrumentation that root-caused #536 was scaffolding, removed once the writer
was identified. If an unattributed-writer class of bug ever reappears,
re-instrument from git history rather than re-deriving.

---

## State Persistence and Concurrency

Run state lives in **one SQLite database per project**, `.rundown/rundown.db`,
in a single `runs` table. Nothing else is authoritative: there is no per-run
JSON state file, no session file, and no file lock guarding run state. Every run
has exactly one writer, its owner, proven by the Owner Token whose hash the row
carries ([ADR 0005](../adr/0005-one-writer-per-run.md)); concurrent CLI
processes are kept from losing each other's writes by a version check on the
row, not by coordination. The one piece of run-adjacent state outside the
database is **captured filesystem output**, which stays under
`.rundown/runs/<run-id>/outputs/` (`outputsDirForRun`,
`packages/core/src/runbook/output-channels.ts`) because it is arbitrary user
data, not authority.

For the normative operator-facing contract — storage locations, the two version
checks, the no-migration rule — see
[docs/reference/runtime.md § State Persistence](../reference/runtime.md#7-state-persistence).
This section describes the implementation behind it.

### Project root

"The project" is one directory, resolved once per command by
`resolveProjectRoot` (`packages/core/src/project-root.ts`): the nearest
directory at or above the start that holds an existing `.rundown/`. The walk
stops at a git boundary (a `.git` directory or file), after checking that
directory's own `.rundown/`; a walk that reaches a git boundary without a match
resolves to that git root, so the first `rundown run` from a subdirectory of a
fresh repository creates `.rundown/` at the git root, where every later command
in the repository finds it. Ancestors of the user's home directory end the walk
unchecked (compared by realpath), and so does home itself unless it holds
`.git`: a stray `~/.rundown/` cannot capture non-git directories below home and
hand them its store, its config and a `{repo}` of the whole home, while a
repository whose root is home (dotfiles in `~`, a container with `HOME=/app`) is
found from its subdirectories like any other. A walk that starts at home or
above it reads that directory's own `.rundown/`. Outside git — the walk reached
the filesystem root or the home boundary without a match — the root falls back
to the start. `resolveProjectRootWith(start, { homeDir })` injects home for
tests. A `stat` that fails for any reason (EACCES, ELOOP, ENOTDIR) counts as
absent, so the walk never throws. It only reads; `.rundown/` is created later,
by the first state save. The same module exports `canonicalPath` (realpath, or
the lexically resolved path when realpath fails), which the CLI and the plugin
use wherever two spellings of one directory must compare equal.

The CLI reads its working directory in one module,
`packages/cli/src/helpers/context.ts`, through two functions. `getProjectRoot()`
is what every command passes down as `cwd`: the store, runbook discovery and
persisted `RunbookRef` source roots, outputs and artifacts, prune,
`.rundown/config.yaml` (`findConfigFile` reads it at the root and does not
walk), the policy evaluator's `{repo}` root, the helper containment boundary and
the step-command working directory. `getInvocationDir()` is the base for paths
the user typed: a relative runbook path given to `run`, `check`, `resolve` or
`scenario`; `--input-file` paths and `file:` values in `--input` /
`--input-json`; and `--helpers` paths. Input paths must still stay inside the
project root, and a helper module outside it is skipped. The policy-file search
also starts at the invocation directory and walks upward, so a sub-package's
stricter policy file wins over the root's. The plugin's SubagentStop gate
(`storeDirectories`) calls the same resolver, so no surface derives the root its
own way. The MCP server spawns the CLI in its own working directory and inherits
this resolution.

### One store, one opener

`packages/core/src/runbook/storage/store-registry.ts` is the sole authoritative
open path: `new RunbookStore(...)` is constructed in exactly one place, inside
`openRunbookStore`. The registry keys open stores by project root, so every
service in a process shares one driver and one connection. The database file is
given owner-only permissions once it exists.

Schema installation is `ensureSchema` (`storage/schema.ts`): it installs the DDL
and stamps `PRAGMA user_version` with `SCHEMA_VERSION` on a fresh database,
no-ops on a matching one, and throws `IncompatibleSchemaError` on anything else.
It never migrates. Because the DDL and the constant live in the same file, any
DDL edit must move `SCHEMA_VERSION`.

### The `runs` table

One row per run. Besides `id`, `created_at` and `updated_at`, it carries:

| Column                                                                            | Meaning                                                                                                                                                                                                                                                                                                                              |
| --------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `lifecycle`                                                                       | `running`, `completed`, `stopped`, or `abandoned`, pinned by a `CHECK`. Its home is this column, not the state JSON.                                                                                                                                                                                                                 |
| `owner_token_hash`                                                                | `UNIQUE` SHA-256 hash of the Owner Token. The token itself is printed once on `runbook_started` and never stored; this hash is the only authority lookup key.                                                                                                                                                                        |
| `parent_run_id`, `parent_step`, `parent_frame_key`, `parent_entry`, `parent_kind` | Child linkage, nullable all-or-none under a `CHECK`, written once when a child row is inserted: an Inline Child at launch (`inline`, no `owner_token_hash`), a Delegation at claim (`delegation`, its own `owner_token_hash`). Pruning a Delegation's parent nulls `parent_run_id` alone (the one orphaned form the `CHECK` admits). |
| `claim_agent_id`                                                                  | The agent id `rundown claim --agent-id` recorded on a Delegation; NULL for every other row (`CHECK`). Part of the linkage: an orphaned Delegation keeps it.                                                                                                                                                                          |
| `lease_attempt`, `lease_pid`, `lease_start_id`, `lease_started_at`                | Execution lease, nullable all-or-none under a `CHECK`. Set by Run Progression before a command turn and cleared by the state write that commits its finish; see [concurrency.md § Execution lease](concurrency.md#execution-lease).                                                                                                  |
| `state_version`                                                                   | Lost-update counter, bumped only by the `runs_bump_state_version` trigger on every `state_json` or `lease_attempt` write.                                                                                                                                                                                                            |
| `state_json`                                                                      | The authoritative `RunbookState` (minus `lifecycle`), including the opaque XState `snapshot`.                                                                                                                                                                                                                                        |

Two triggers complete the schema. `runs_bump_state_version` owns
`state_version`, so the conditional write below is a complete lost-update check
for every writer by construction rather than by call-site discipline. It fires
on the lease column too, so setting the execution lease moves the version and
the lease's `attempt` is the version it produced. `runs_unlink_children` unlinks
any Delegation naming a deleted run as its parent by nulling `parent_run_id`
alone and keeping the rest of the group — the one orphaned form the linkage
`CHECK` admits, read as `orphaned_delegation` so the child's commands are
refused `PARENT_RUN_FINISHED` — and deletes the deleted run's Inline Children.
The referential action `ON DELETE SET NULL` is not used, so the trigger, not the
foreign key, decides what an orphan keeps.

### Two schema versions, deliberately distinct

They are separate mechanisms with separate failure modes, and conflating them is
a documented mistake:

| Version                      | Governs                                                                            | Where it lives         | Rule                                                |
| ---------------------------- | ---------------------------------------------------------------------------------- | ---------------------- | --------------------------------------------------- |
| SQLite storage schema        | The whole database — the DDL of the `runs` table and its triggers                  | `PRAGMA user_version`  | Must equal `SCHEMA_VERSION` (currently `8`)         |
| `RunbookState.schemaVersion` | One run's structured state fields and its opaque `snapshot` blob, and nothing else | The row's `state_json` | Must equal `CURRENT_SCHEMA_VERSION` (currently `4`) |

A wrong storage version invalidates the whole database (`RD-305`); a wrong
`RunbookState.schemaVersion` invalidates **only that run** (`RD-309`). The two
happen to read the same number because one change moved both; neither moves the
other. Neither version is ever migrated, hydrated, shimmed, or dual-read — the
recovery path is always explicit user action. A run row at any other
`schemaVersion` fails the version gate as `invalid_schema_version` before its
structure or opaque snapshot is parsed.

### Writes: one conditional save, refused on a race

`RunbookStore` (`storage/runbook-store.ts`) validates every row it reads — the
persisted-state gates and the Zod structural parse — so no unvalidated row
escapes the store. Reads return the state together with the `state_version` it
was read at (`VersionedRunState`); `findRunByOwnerTokenHash` is the lookup
behind `resolveOwnedRun`.

A state write is `saveRun(runId, expectedVersion, state)`: **one** conditional
`UPDATE … WHERE state_version = :expected`. It returns `committed`,
`concurrent_modification` (the row moved since the caller read it; nothing was
written), or `missing`. There is no retry, no backoff and no second attempt in
the store or above it. Under one writer per run the only concurrent writer is
the owner's own second command, and a retry would let it land silently behind
the first, so the caller is told instead. `RunbookStateManager.save` passes the
outcome through to the lifecycle seam and Run Progression, which render it as
`CONCURRENT_MODIFICATION`; `RunbookStateManager.update` / `mutate` read once,
derive once, save once, and throw `ConcurrentStateModificationError` on a moved
version without re-running the derivation.

A command effect is never inside that write. Run Progression runs a step's
command and then commits its result under the version it read; if the version
moved meanwhile, the command has run but its result is not recorded, and the
activation reports `command_not_committed` rather than retrying (see
[§ Run Progression after the seam](#run-progression-after-the-seam)).

### Drivers: two implementations, one atomicity bar

`storage/driver-factory.ts` selects the driver, and the selection is
fail-closed:

- **`node:sqlite` (native)** everywhere real multi-process concurrency exists.
  The database is opened in WAL mode with `PRAGMA busy_timeout = 5000` and
  `PRAGMA foreign_keys = ON`; every write runs as a short `BEGIN IMMEDIATE` with
  explicit rollback, plus a bounded application-level retry (10 retries after
  the first attempt, backing off `25ms × attempt`) for the `SQLITE_BUSY` that
  escapes the busy timeout. This retries acquiring the database write lock, not
  a refused version check. `BEGIN IMMEDIATE` rather than deferred is deliberate:
  it converts a mid-transaction upgrade failure into an entry-point one the
  retry loop can handle. If native SQLite cannot initialise, the factory raises
  `NativeSqliteUnavailableError` — it does **not** fall back.
- **`sql.js` (WASM)** only inside WebContainer, identified positively by the
  `jsh` shell marker. Forcing it anywhere else raises
  `SqljsUnsupportedHostError`, because the adapter is single-writer and would
  reintroduce the hazard the native driver rules out.

**The atomicity bar is identical on both drivers.** `sqljs-driver.ts` issues a
plain `BEGIN` rather than `BEGIN IMMEDIATE`, but exclusion does not come from
the SQL verb: each critical section runs behind an in-process mutex and an
advisory file lock, with the load → `BEGIN` → work → `COMMIT` → durable-export →
close cycle entirely inside that lock. The property that matters — the version
check and the write in one statement — lives in `RunbookStore`, not in either
driver.

Where the two genuinely differ is the multi-process guarantee, and that
difference is confined by construction: the sql.js adapter declares
`capabilities.multiProcess: false`, and `driver-factory.ts` only ever selects it
on a host that is single-writer anyway.

Both drivers take **synchronous** transaction callbacks (`SyncWork`, enforced at
runtime by `assertSyncWorkResult`), which makes it structurally impossible to
hold a transaction open across an awaited external effect.

### File locks

`file-lock.ts` survives for file-backed artifacts only: the artifact manifest's
read-modify-append and the sql.js driver's durable-replacement critical section.
The plugin keeps no state of its own. Neither remaining lock guards run state,
and neither may be extended to: a new write to run state goes through the
conditional save above.

A held lock is released with `await using` (`heldLock`, a `ScopedLock`), never
from a bare `finally`. Release is best-effort and non-propagating (RD-102): a
failed unlink leaks only a self-healing lock, reclaimed by the next acquirer via
PID-aware stale detection, and must never replace the committed outcome of the
work it protected.

---

## XState Compiler

The compiler in `packages/core/src/runbook/compiler.ts` builds XState v5
machines from parsed Markdown. State IDs, transition targets, and per-step
actions are determined at runtime, so XState's compile-time checks of state
names and transition targets do not apply to the generated graph. This section
captures the patterns that keep type safety where it matters despite dynamic
generation. For generic XState v5 + TypeScript reference material, see
[xstate-patterns.md](./xstate-patterns.md).

### Why dynamic compilation matters for type safety

The compiler builds machine configs from parsed Markdown:

- State IDs are computed strings (`"step::1::2"`, not literal types)
- Transition targets are computed — TypeScript cannot verify they exist
- The set of states and transitions changes per runbook

`setup({ types })` is still used for context/event typing, and that typing is
enforced exactly as it is for a hand-authored machine. The dynamic part is the
state graph layered on top.

### Where type safety matters: boundaries vs the generated graph

Focus type safety on **boundaries** and **stable operations**, not on the
generated graph:

| Boundary                           | Status                                                                     | Target pattern                                 |
| ---------------------------------- | -------------------------------------------------------------------------- | ---------------------------------------------- |
| `RunbookEvent` discriminated union | Strong                                                                     | (already correct)                              |
| `RunbookContext` interface         | Strong                                                                     | (already correct)                              |
| `LastAction` discriminated union   | Strong                                                                     | (already correct)                              |
| `assign()` internals               | Weak — `AssignAction = (...args: never[]) => unknown` erases context types | `runbookSetup.assign()`                        |
| State config shape                 | Weak — `TransitionEntry` uses `unknown` fields                             | `setup().createStateConfig()`                  |
| Stable per-step operations         | Inline, untyped                                                            | Named actions in `setup()` with typed `params` |
| Snapshot persistence               | Weak — `as any` casts in narrowing                                         | Typed narrowing functions                      |

### Hybrid pattern: stable named actions + dynamic params

Even though the graph is dynamic, many operations are stable and repeat across
generated states: reset retry counters, set `lastAction`, append pass/fail
results, initialize/clear FOR context, set current substep.

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

This gives compile-time check that the action exists, compile-time check that
`params` matches the expected shape, and runtime flexibility for the dynamic
state generation.

### Validated graph builder

For dynamic compilers, use a two-phase build:

1. Generate all state IDs first (single source of truth)
2. Resolve transition targets through a `toStateId(...)` resolver — never raw
   strings
3. Validate graph integrity before `createMachine()`:
   - **Target existence** — every `target` resolves to a generated state or a
     known terminal (`COMPLETE`, `STOPPED`). Fail fast:
     `"unknown target step::9::2 referenced from step::4::1 PASS"`.
   - **Uniqueness** — no duplicate state IDs were generated.
   - **Valid initial** — the computed `initial` state exists in the generated
     set.
   - **Semantic invariants** — e.g. `BREAK` must not appear in parent
     aggregation transitions; retry states must exist when `retry > 0`.
4. Only then emit XState state configs.

Optional hardening: brand `StateId` (`string & { __brand: 'StateId' }`) so raw
string targets are a type error. Keep target resolution in one module so
failures include source/target context.

### Migration priorities

1. **`runbookSetup.assign()`** instead of raw `assign()` — immediate type-safety
   win, no restructuring needed.
2. **Named stable actions in `setup()`** with typed `params` — hybrid pattern
   above.
3. **`createStateConfig()` wrapping** at insertion — validates each generated
   state config. Build incrementally as today, then pass through
   `runbookSetup.createStateConfig(...)` as the final step before inserting into
   `states`.
4. **Validated graph builder + target resolver API** — eliminate raw target
   strings during generation.
5. **Runtime graph validation** — catches what TypeScript cannot prove.
6. **Explicit return type** on `compileRunbookToMachine()`.
7. **Specialize `AnyActorRef`** with `ActorRefFrom<typeof machine>` in
   `actor-service.ts`.
8. **Reduce `as any`** in snapshot migration with typed narrowing functions.

---

## Retry Counters

Three counters track retry attempts. They are not interchangeable — unifying
them breaks the retry-budget guards.

| Counter               | Site A writes (parent-aggregation retry) | Site B writes (FOR-iteration retry) | Consumer                                                          | Purpose                                                                                                                                                              |
| --------------------- | ---------------------------------------- | ----------------------------------- | ----------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `parentRetryCount`    | increments by 1                          | unchanged                           | parent retry-budget guard (`parentRetryCount < transition.retry`) | machine-invariant counter for the parent's `RETRY` budget                                                                                                            |
| `iterationRetryCount` | resets to 0                              | increments by 1                     | FOR-iteration retry-budget guard                                  | machine-invariant counter for the iteration's `RETRY` budget; reset on parent re-entry because re-entering the parent invalidates any in-progress iteration's budget |
| `retryCount`          | increments by 1                          | increments by 1                     | actor-service / `rundown echo --result` / state output            | user-visible counter — surfaces total retry attempts regardless of layer                                                                                             |

**Why the split:** `parentRetryCount` and `iterationRetryCount` are budget
guards — they must increment at exactly one site each so the corresponding guard
exhausts predictably. `retryCount` is observability — every retry transition (at
either site) advances it. Unifying machine-invariant counters with the
user-visible counter would either prevent the parent budget from exhausting (if
Site B did not increment) or double-count parent retries (if `parentRetryCount`
were also bumped at Site B).

See `packages/core/src/runbook/compiler.ts` for the two assign sites.

---

## WebContainer Environment

In WebContainer environments (e.g., StackBlitz), nested process spawning may not
work correctly. The CLI includes an internal command dispatcher
(`packages/cli/src/services/internal-commands.ts`) that intercepts
`rd`/`rundown` commands and executes them directly without spawning a child
process.

- `isInternalRdCommand()` detects rd/rundown commands
- `executeRdCommandInternal()` dispatches to internal handlers
- Currently supported: `echo`, `prompt` commands
- Unsupported commands fall back to standard spawn behavior

### Storage in WebContainer

WebContainer stubs `node:sqlite`, so the native driver cannot back a run there.
`storage/driver-factory.ts` selects the WASM `sql.js` driver instead, and does
so on a **positive** signal — the `jsh` shell marker — rather than by catching a
native failure. The selection is one-way: forcing sql.js on any other host is
refused with `SqljsUnsupportedHostError`, because that adapter is single-writer
and the refusal is what stops an env var becoming a supported way to reintroduce
the multi-writer hazard. See
[§ Drivers](#drivers-two-implementations-one-atomicity-bar) for why the
atomicity bar is nonetheless identical on both.

`site/tests/sqlite-substrate.spec.ts` is the standing guard on the empirical
findings that justify this arrangement: native `node:sqlite` is stubbed, WASM
sql.js persists a database across sequential processes, and the shell marker
holds. It boots its own files, so it runs without the snapshot. The
complementary proof that the **built** snapshot ships a working sql.js and
executes runbooks off it lives in `site/tests/runbook-runner.spec.ts`.

### Site snapshot: size budget and pruning

The marketing site (`site/`) boots the CLI in the browser from a prebuilt
WebContainer snapshot, `site/public/rundown-snapshot.bin`. The snapshot is a
single static file that packs the CLI's entire installed `node_modules`, and
Cloudflare Pages — where the site deploys — rejects any single file over 25 MiB.
Every runtime dependency of `@rundown-org/cli` is therefore paid for twice: once
as a real dependency, and again as static-asset weight against that hard ceiling
(issue #639).

`site/scripts/build-snapshot.ts` installs the packed `parser`/`core`/`cli`
tarballs into a temp directory, prunes, snapshots the result, and asserts the
size:

- **`prune-sqljs.mjs`** drops the sql.js build variants the driver never loads
  (asm.js fallbacks, debug builds, browser workers — ~17 MiB), keeping the
  loader and its `.wasm` derived from the package's own `main`/`exports`.
- **`prune-non-runtime.mjs`** drops files nothing in the snapshot can execute:
  type declarations, published TypeScript sources (`.ts`/`.tsx`), source maps
  and package docs. There is no `tsc`, bundler or devtools inside the snapshot,
  so these are weight and nothing else; source maps are doubly dead, naming
  `../src/*` sources the tarballs never ship. Two things are deliberately kept:
  `runbooks/` trees (the CLI's bundled `.runbook.md` files are runtime data that
  happens to be markdown) and licence/notice texts (the snapshot redistributes
  third-party code to every visitor). TypeScript pruning is gated per package on
  the package's own manifest — a source-first package that resolves to `.ts` at
  runtime keeps its sources — and honours only export conditions Node can
  resolve, so bundler-only metadata (`module`, `@zod/source`) does not protect
  sources the demo can never reach.
- **`snapshot-budget.mjs`** fails the build at 12 MiB — kept close to the ~9.4
  MiB asset, not just below the 25 MiB cap — so growth is caught in a GitHub
  check (the CI `playwright` job builds the snapshot) with a readable log,
  instead of a post-merge Cloudflare deploy failure. Retune the budget
  deliberately when the asset itself moves.
