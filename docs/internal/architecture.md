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
rests in `idle`. A DELEGATE or runbook-list substep compiles to the same leaf as
any other: there is no issuance or launch-intent child and no completion
mailbox, and its PASS/FAIL is sent directly by the lifecycle seam after `--step`
validation. Core refuses to create a run of such a runbook
(`RUNBOOK_COMPOSITION_UNSUPPORTED`; see
[§ Lifecycle Command Seam](#lifecycle-command-seam)).

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
`COMMAND_RESULT` comes from the compiled machine's own command actor; and
`SET_VARIABLES` has a machine handler but no front-end sender. None of them
appear above. `packages/core/src/runbook/compiler.ts` remains the authority on
the union.

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
`awaiting` / `runnable`; the rendered command travels only on the `runnable`
arm, inside a nominally branded record the module is the sole producer of.

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
nothing else. The plaintext token appears in exactly one place, the
`runbook_started` event, and never in a message, a row, or a refusal.

The same module holds `findUnsupportedComposition(steps)`, the decision behind
`RUNBOOK_COMPOSITION_UNSUPPORTED`. `RunbookStateManager.create` applies it
before minting a run id or writing a row, throwing
`RunbookCompositionUnsupportedError` for a runbook whose substeps are authored
`DELEGATE` or carry a runbook list, until inline composition (#903) and
delegation (#904) return on this model. Every front end that creates a run is
refused the same way; the CLI only renders the ids core names, and
`rundown check` warns from the same predicate.

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
  to whether composition owes a further turn; with composition refused at
  `rundown run`, it is always `none`.
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
`compileRunbookToMachine`; the activation itself takes only
`{ manager, actorService, loadSteps, sink }`.

### Guards do no cross-run IO or policy

Nothing in the seam or the activation reads another run. XState guards express
per-run domain conditions; ownership, `--step` confirmation and the version
check all happen at the seam boundary, which is what lets the state machine
remain a pure per-run program.

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

| Column                                                                            | Meaning                                                                                                                                                                                                                             |
| --------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `lifecycle`                                                                       | `running`, `completed`, `stopped`, or `abandoned`, pinned by a `CHECK`. Its home is this column, not the state JSON.                                                                                                                |
| `owner_token_hash`                                                                | `UNIQUE` SHA-256 hash of the Owner Token. The token itself is printed once on `runbook_started` and never stored; this hash is the only authority lookup key.                                                                       |
| `parent_run_id`, `parent_step`, `parent_frame_key`, `parent_entry`, `parent_kind` | Child linkage, nullable all-or-none under a `CHECK`. Nothing writes it today: core refuses to create a run of a composing runbook.                                                                                                  |
| `lease_attempt`, `lease_pid`, `lease_start_id`, `lease_started_at`                | Execution lease, nullable all-or-none under a `CHECK`. Set by Run Progression before a command turn and cleared by the state write that commits its finish; see [concurrency.md § Execution lease](concurrency.md#execution-lease). |
| `state_version`                                                                   | Lost-update counter, bumped only by the `runs_bump_state_version` trigger on every `state_json` or `lease_attempt` write.                                                                                                           |
| `state_json`                                                                      | The authoritative `RunbookState` (minus `lifecycle`), including the opaque XState `snapshot`.                                                                                                                                       |

Two triggers complete the schema. `runs_bump_state_version` owns
`state_version`, so the conditional write below is a complete lost-update check
for every writer by construction rather than by call-site discipline. It fires
on the lease column too, so setting the execution lease moves the version and
the lease's `attempt` is the version it produced. `runs_unlink_children` clears
the whole linkage group of any row naming a deleted run as its parent; the
referential action `ON DELETE SET NULL` would null `parent_run_id` alone, which
the all-or-none `CHECK` then refuses.

### Two schema versions, deliberately distinct

They are separate mechanisms with separate failure modes, and conflating them is
a documented mistake:

| Version                      | Governs                                                                            | Where it lives         | Rule                                                |
| ---------------------------- | ---------------------------------------------------------------------------------- | ---------------------- | --------------------------------------------------- |
| SQLite storage schema        | The whole database — the DDL of the `runs` table and its triggers                  | `PRAGMA user_version`  | Must equal `SCHEMA_VERSION` (currently `4`)         |
| `RunbookState.schemaVersion` | One run's structured state fields and its opaque `snapshot` blob, and nothing else | The row's `state_json` | Must equal `CURRENT_SCHEMA_VERSION` (currently `3`) |

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
The plugin's `PluginSessionLock` guards the plugin's own
`.claude/session/state.json`, which was never part of the store. None of them
guards run state, and none may be extended to: a new write to run state goes
through the conditional save above.

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
