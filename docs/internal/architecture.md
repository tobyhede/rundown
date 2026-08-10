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
| **Persistence**   | One SQLite database     | Run, session, and claim authority survives context clears          |
| **Concurrency**   | Transactions and leases | Serialises concurrent CLI processes against that authority         |
| **Iteration**     | Machine-owned actors    | Per-iteration data source value resolution and machine transitions |

The CLI is an orchestration and control interface. Claude executes the actual
work.

```text
[Runbook File] --> [Parser] --> [XState Machine] --> [State Manager]
                                       ^                    |
                                       |                    v
                              [CLI Commands] <---- [.rundown/rundown.db]
                                                    (SQLite: runs, session,
                                                     claims, execution leases)
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
`InternalFailureLastAction` sub-union — `RETRY_ERROR`, `OUTPUT_CAPTURE_FAILED`,
`ARTIFACT_RESOLUTION_FAILED`, `FOR_RESOLUTION_FAILED`,
`COMMAND_EXECUTION_FAILED`, `DELEGATION_ISSUANCE_FAILED`, and
`INLINE_LAUNCH_FAILED`. (`lastMessage` itself remains a legitimate diagnostic
carrier for free-form context — what is forbidden is _type discrimination_ via
string parsing of it.)

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
`POLICY_DENIED` and the `InternalFailureLastAction` sub-union (`RETRY_ERROR`,
`OUTPUT_CAPTURE_FAILED`, `ARTIFACT_RESOLUTION_FAILED`, `FOR_RESOLUTION_FAILED`,
`COMMAND_EXECUTION_FAILED`, `DELEGATION_ISSUANCE_FAILED`,
`INLINE_LAUNCH_FAILED`) — see `packages/core/src/runbook/types.ts` and
[§ Typed `lastAction` discriminants](#typed-lastaction-discriminants).

`DELEGATION_ISSUANCE_FAILED` carries a `reason` discriminant with three
producers, all in `delegationIssueActor`:

| `reason`                       | Produced when                                                                                                                                                                 |
| ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `actor_context_required`       | The leaf has DELEGATE targets but the actor's `issueCredential` input is absent, so no verified claim-bound issuer can mint the credentials                                   |
| `delegation_resolution_failed` | `inferAllDelegateSubsteps` threw for any reason other than RD-819, an authored child runbook reference did not resolve, or `createDelegation` returned a non-`created` status |
| `nested_delegation_forbidden`  | The parent runbook is itself a claimed delegation child (RD-819); delegation is single-level                                                                                  |

`actor_context_required` is the newest of the three, and is the machine-side
half of the deterministic-credential authority model: a delegation token is
derived from the issuing claim's secret, so a frontier the machine cannot mint
under a verified claim is refused rather than minted unbound. All three reasons
route through `setDelegationIssuanceFailed`, which sets `lifecycle: 'stopped'`
and stores the reason on `lastAction`; `deriveStoppedReason` then passes the
discriminant through verbatim, so `actor_context_required` is also the public
`RUNBOOK_STOPPED` reason a front end renders. It is a machine-internal
`lastAction` variant, not the `ACTOR_CONTEXT_REQUIRED` CLI error code — the two
name the same missing authority at different boundaries.

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

A fourth side-effect child, `__issue-delegations`, runs after
`__resolve-artifacts` when the leaf has delegations to issue. It invokes
`delegationIssueActor` (wired via `buildDelegationIssueInvokeBlock`) to create
delegation tokens for the step's child runbooks before the leaf reaches `idle`.

Non-DELEGATE child-runbook substeps use the adjacent `__prepare-inline-launch`
child. The compiler chooses the post-artifact child in priority order:
`__issue-delegations` for authored delegation frontiers,
`__prepare-inline-launch` for inline child runbook references, otherwise `idle`.
`__prepare-inline-launch` invokes `inlineLaunchIntentActor`, which validates
that inline launch is allowed in the current scope, resolves the authored child
runbook reference, allocates the child run id, snapshots inherited context,
stores a running substep record with inline metadata, and writes
`context.inlineLaunchIntent`. This is core-owned launch intent, not a CLI
inference from parser shape.

The actor does not start the child process or write child state. Those external
effects remain in the CLI boundary: the execution loop consumes the persisted
intent, creates or resumes the child run with the preallocated id, records
`INLINE_CHILD_STARTED` on the parent, and sends `INLINE_LAUNCH_CONSUMED` after
the one-shot intent has been handled. If preparation fails, the machine records
`INLINE_LAUNCH_FAILED` and stops the active runbook; the CLI must not fall back
to local substep execution.

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
  before its initial child's `invoke` input factory is read, so
  `__issue-delegations` and `__prepare-inline-launch` see the advanced value.

`syncFrameEntry` is **not** attached to `step::N::__parent-entry::M`: each is a
same-frame artifact pass-through that routes on to the real leaf, and bumping
there would double-count.

The bump rule lives in `advanceFrameEntry` (`frame-entry.ts`) and the frame-key
derivation in `frameKeyForCursor` (`targeting.ts`), the single derivation. Every
cursor-keyed site routes through it: `deriveActiveFrame`,
`deriveActorStatePatch`, `syncFrameEntry`, `buildDelegationIssueInvokeBlock`,
`buildInlineLaunchInvokeBlock`, `buildSubstepGotoResetAssignValue`, the two
inline `advanceFrameEntry` calls on the `runRetryHook` transitions, and
`runRetryHook`'s own `activeFrameKey`. The rule it replaced filtered `implicit`
but never compared `stepId`; the two answers coincide for every stack
`initForStack` can build today, so the guard is a construction rather than a
live repair, and `targeting.test.ts` pins both the consumers and the absence of
any fourth rewrite. The entry ordinal is run-global and monotonic —
`max(frameEntryCounts[target] ?? 0, previousActiveEntry) + 1` — not
per-frame-local; `classifyDelegationLiveness` and completion-key scoping depend
on that form.

**Re-entry is declared, not inferred.** Every transition that writes a `GOTO` or
`RETRY` `lastAction` also writes the one-shot `context.frameReentry` marker,
which the first following `syncFrameEntry` consumes and clears. The split is
deliberate: a transition knows _that_ it re-enters but not yet _which_ frame
(the FOR iteration is only current after the leaf's `initForStack` runs), and
one transition can drive several state entries — `__parent-entry::` routing is
two — which a one-shot marker survives and a `lastAction` read does not.
`RETRY_ERROR` sets no marker; it routes to `STOPPED` and enters no frame.

**Self-targeting transitions declare `reenter: true`.** A GOTO onto the leaf the
cursor already occupies, and a RETRY on a step with no parent `ARTIFACTS` to
route through, both target their own source. XState v5 defaults `reenter` to
`false`, and for such a transition `getTransitionDomain` returns the source, so
`computeEntrySet` never adds it and the source's `entry` array does not run —
while `addDescendantStatesToEnter` still re-enters the leaf's children. Left
alone that skips `syncFrameEntry` on a genuine re-entry (the transition resets
the frame's substep rows, increments `retryCount` and re-fires
`__issue-delegations`) and leaks the one-shot marker onto the _next_ state
entry, which then bumps a within-frame advance. `selfTargetReentry` in
`compiler.ts` attaches `reenter: true` wherever the routed target equals the
source id, and only there — for a distinct target the domain is already the
least common ancestor and the flag would be inert. The parent-aggregation retry
also self-targets and is deliberately excluded: it carries no entry actions and
relies on the assign settling before a sibling priority-0 `always` routes
onward.

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
and exit, the recovery reconcile, and the initial context. RETRY leaves it
untouched in both directions: a retry re-enters the same unit without taking a
loop pass. `compiler.test.ts` ("loop-counter reset sites") drives one test per
site; `self-goto-counter.source-text.test.ts` asserts the pairing structurally
so a site added later cannot ship unpaired.

**Entry ordinals are not FOR bounds.** `RunbookState.activeEntry` and every
value in `frameEntryCounts` are run-global monotonic ordinals. They were capped
at `MAX_FOR_BOUND` — the largest iteration count one `FOR` clause may declare —
which made this bound unobservable through persisted state: the ordinal starts
at 1 and bumps once per pass, so the last admitted pass reaches 10001, one past
the cap. `update` does not validate its write, so the run committed state its
own next read refused (`RunbookStateManager.load` threw
`InvalidRunbookStateError`; `RunbookStore.loadRun` and the next `update` let a
raw `ZodError` escape) and the run wedged until pruned. `schemas.ts` now
validates all three entry ordinals — `activeEntry`, `frameEntryCounts`, and
`ResolvedCompletion.targetEntry` — as safe integers with no domain ceiling;
`targetIteration`, which really is a `FOR` iteration index, keeps
`MAX_FOR_BOUND`.

**The two `runRetryHook` sites are the exception.** `runRetryHook` is invoked
from a transition `assign`, and transition actions run before the target's entry
actions, so `syncFrameEntry` cannot serve it. Both sites call
`advanceFrameEntry` inline, hand the hook the advanced coordinates, and
deliberately set no marker — the entry action that follows is then a no-op for
that frame. On a FOR parent the frame they advance is the **bare step frame**,
not the iteration frame: the loop has exhausted by the time the parent
aggregation resolves, so `frameKeyForCursor` finds no active FOR context. That
is the same derivation `runRetryHook` performs on the coordinates it receives,
so the two agree by construction. The parent-aggregation site then assigns
`forStack: EMPTY_FOR_STACK`, and the leaf `initForStack` that follows rebuilds
the loop at `forClause.start` — a second, genuinely different frame, scored once
by the entry action.

### Delegated Command Infrastructure Terminals

Command execution is a machine-owned Category C side effect. The command actor
can produce authored runbook outcomes (`pass` and `fail`) or command
infrastructure terminal reasons such as `POLICY_DENIED` and
`COMMAND_EXECUTION_FAILED`. Delegation propagation projects terminal children
through `projectDelegationTerminalOutcome`; it must not infer delegated `fail`
from `lifecycle: stopped` alone.

Policy denial and command execution failure leave the linked child terminal for
operator recovery. A retry over that terminal linked child supersedes stale
delegation outcomes and removes the stale claim record without deleting the
child run. `abort --force` can also cancel the resolved linked delegation
without recording a fresh delegated fail.

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

`context.frameEntry` is the canonical event-time-bound dependency: machine-owned
delegation issuance reads it inside `buildDelegationIssueInvokeBlock`'s `input`
factory at fire time, after the leaf's `syncFrameEntry` entry action has made it
current (see [§ Frame entry ownership](#frame-entry-ownership)). It is plain
data and serialises into the persisted snapshot; no function reference or
process-runtime value travels with it.

### Manual delegation preparation machine

The compiled runbook machine is not the only machine in core.
`packages/core/src/runbook/manual-delegation-machine.ts` holds a second, much
smaller one: `prepareManualDelegation` builds an ephemeral XState actor, `send`s
it exactly one command, reads the result out of its context, and stops it. It is
the dispatch seam for the three operator-initiated delegation commands —
`ISSUE`, `RETRY`, `ABORT` — behind
`RunbookActorService.prepareManualDelegationMutation`.

**Why a machine with a single state.** The machine has one `ready` state and
three action-only self-handlers, and that is the intended shape rather than
scaffolding for states still to come. Manual preparation is a single synchronous
decision over an exact captured state — there is no intermediate lifecycle for a
state graph to model — so the value the machine carries is dispatch, not
sequencing: the command union is XState's event type, `ready.on` is proved total
over that union by a `satisfies ManualDelegationReadyHandlers` check (XState
does not otherwise require `on` to be total, so a new command variant would
compile, be silently ignored, and surface as a missing result), and the
delegation primitives `createDelegation` / `retryDelegation` / `abortDelegation`
stay behind machine dispatch as the architecture requires instead of being
called directly by a service — the defect this seam was introduced to remove.

Sequencing lives elsewhere by design, and the durable side of these workflows
belongs to the aggregate execution fence: the machine performs no persistence
and its context is never persisted. The caller commits the returned substep
state.

**Runtime authority and throws.** The verified claim-bound
`DelegationCredentialIssuer` is bound in the machine-construction closure, never
in machine context — the same rule as
[§ Actor input wiring](#actor-input-wiring). A throw escaping an `assign`
callback does not propagate out of `actor.send()`: the send returns normally
with the context unassigned and XState re-reports the error asynchronously
through its unhandled-error path, terminating the process instead of reaching
the CLI error envelope. Each handler therefore boxes an unexpected throw into
context and `prepareManualDelegation` rethrows the original value, identity
intact. Domain refusals are separate: they are typed `status` arms
(`already_cancelled`, `needs_force`, `child_in_flight`, `error`), never mapped
onto a throw.

**Commit path back into the compiled machine.** Only one of the three commands
re-enters the compiled runbook machine. `prepareManualDelegationMutation` sends
`MANUAL_DELEGATION_ABORT_PREPARED` through `prepareActorMutation` when the
command was `ABORT` **and** the captured parent state carries a persisted
snapshot. `ISSUE`, `RETRY`, and an `ABORT` over a state with no snapshot return
`{ ...previousState, substepStates }` directly, without a machine event. On the
compiled-machine side the event is a root-level `on` handler that assigns
`context.substepStates` — no target, no guard, no derivation.

The design record does not settle the longer trajectory. The PR 12 planning
audit requires manual delegation to be machine-owned and separately contemplates
transient per-leaf workflow substates in the compiled runbook machine, but it
does not say whether these three commands eventually migrate into that graph.
Migrating the `ISSUE`/`RETRY` arms onto the existing `delegationIssueActor` is a
deferred follow-up under the delegation-lifecycle hardening epic. Treat the
single state as today's deliberate design, not as a scheduled roadmap in either
direction.

---

## CLI ↔ Core Event Boundary

The CLI and core packages communicate through a typed event boundary. Two flows:
events the CLI sends into the machine, and observable events the CLI renders by
translating snapshot transitions.

### Events the CLI sends into the machine

| Event                                                                          | Source                                                          | Notes                                                                                                                                 |
| ------------------------------------------------------------------------------ | --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `PASS` / `FAIL`                                                                | `rundown pass` / `rundown fail` STDIN, substep-completion drain | Only from external user actions or pre-persisted completion records. The CLI MUST NOT synthesise these from internal observation.     |
| `GOTO { target }`                                                              | `rundown goto`                                                  | Jumps. `target` is a `StepId`. The CLI's `--index` flag is resolved before dispatch; the event itself carries no index field.         |
| `RETRY`                                                                        | (internal — generated by retry transitions)                     |                                                                                                                                       |
| `SET_VARIABLES { vars }`                                                       | Delegation completion                                           | Used when a child runbook reports back.                                                                                               |
| `DELEGATE_FRONTIER_CONSUMED`                                                   | Delegation issuance                                             | Acknowledges the front end emitted the auto-issued delegation frontier.                                                               |
| `INLINE_CHILD_STARTED { parentStepId, parentFrameKey, childRunId, startedAt }` | Inline launch side effect                                       | Records that the front end has created and started the inline child runbook for the machine-owned intent.                             |
| `INLINE_LAUNCH_CONSUMED`                                                       | Inline launch side effect                                       | Clears the one-shot `inlineLaunchIntent` after the front end has consumed it.                                                         |
| `DELEGATION_CHILD_LINKED` / `DELEGATION_CHILD_UNLINKED`                        | `RunbookActorService` (core-internal)                           | Records or clears the parent-side link to a claimed child run. Not front-end reachable.                                               |
| `MANUAL_DELEGATION_ABORT_PREPARED { substepStates }`                           | `RunbookActorService` (core-internal)                           | Commits a machine-prepared manual `abort` back into the compiled machine. Root-level `assign` only — no target, guard, or derivation. |

Two qualifications on this table, both load-bearing.

**It is not the whole `RunbookEvent` union.** `FORCE_STOP`, `FORCE_COMPLETE`,
`APPLY_CURRENT_RESOLVED_COMPLETION`, and `COMMAND_RESULT` are driven by core
(the lifecycle command seam, the completion service, and the compiled machine's
own command actor); `EXECUTE_COMMAND` is sent by the CLI execution loop. None of
them appear above. `packages/core/src/runbook/compiler.ts` remains the authority
on the union.

**Not every member is CLI-originated.** The last three rows are sent by
`RunbookActorService` inside core, not by a front end. The invariant that still
holds — and the rule new work must satisfy — is the direction of the arrow, not
the caller: a new CLI subcommand dispatches into existing events, and any new
event arrives with its corresponding state-machine handler rather than as a
protocol extension a front end can drive. Transitional events introduced during
incremental migrations (e.g. an event that bridges a CLI-owned side effect to a
machine-owned one before the side effect itself moves into the machine) are
scoped to the migration window and removed once the boundary collapses — they do
not become permanent fixtures of the protocol.
`MANUAL_DELEGATION_ABORT_PREPARED` is the current instance of that pattern; see
[§ Manual delegation preparation machine](#manual-delegation-preparation-machine).

### Observable events the CLI renders

The CLI subscribes to actor state changes and translates them into observer
events for stdout/stderr (and for the MCP server when it is the front end):

| Event                                                     | When                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `STEP_ENTERED { stepId, ... }`                            | On entering a step state                                                                                                                                                                                                                                                                                                                                                                                                             |
| `RUNBOOK_STOPPED { reason, message }`                     | Final state, lifecycle = `'stopped'`. `reason` is narrowed from a typed `lastAction` variant where applicable. Payload shape defined in `packages/core/src/events/types.ts`.                                                                                                                                                                                                                                                         |
| `RUNBOOK_COMPLETED`                                       | Final state, lifecycle = `'completed'`                                                                                                                                                                                                                                                                                                                                                                                               |
| `ERROR_OCCURRED { code, message }`                        | When a typed `lastAction` variant indicates a machine-internal failure (e.g. `RETRY_ERROR`). See [Typed `lastAction` Discriminants](#typed-lastaction-discriminants).                                                                                                                                                                                                                                                                |
| `COMMAND_STARTED` / `COMMAND_COMPLETED` / `POLICY_DENIED` | Machine-owned. Command execution is the Category C actor `commandExecActor` (`packages/core/src/runbook/actors/command-exec-actor.ts`), wired into every leaf in `compiler.ts`. These observations flow through the `MachineExecutionObserver` effect collector in core (`packages/core/src/events/execution-observation.ts`); the CLI supplies the `runExternalCommand` services that the actor calls but does not emit the events. |

`STEP_ENTERED` may include `delegateFrontier` for authored `- DELEGATE` targets
or `inlineLaunch` for non-DELEGATE child-runbook targets. `inlineLaunch` is
projected from persisted `context.inlineLaunchIntent` by
`RunbookActorService.observeExecutionUnitEntry`; it includes the parent
identity, parent frame, preallocated child run id, and child runbook reference.
The CLI launch loop consumes this typed intent, creates the child run with
inline parent linkage, sends `INLINE_CHILD_STARTED`, then sends
`INLINE_LAUNCH_CONSUMED`. Variable inheritance uses the internal context
snapshot carried on the intent, but the public JSON renderer redacts that
snapshot from `step_entered.inlineLaunch`.

The narrowing layer between snapshot context and observer events uses the typed
`lastAction` discriminant convention — never `lastMessage` string parsing.

---

## Lifecycle Command Seam

Cross-run lifecycle mutations (`rundown pass` / `rundown fail`, plus the
transitional bare `rundown delegate` policy precheck) enter core through one
seam: `RunbookLifecycleCommandService`
(`packages/core/src/runbook/lifecycle-command-service.ts`). This is the single
place direct-CLI cross-run pass/fail mutations cross into core, mirroring
`RunbookCollectionService` as the resolve → gate → drive-machine model. The
seam, not the CLI, owns the runbook logic; the CLI is a thin front end around
it.

### What the seam owns

`runTransition` performs, in order:

1. **Evidence → context mapping.** Typed `CallerEvidence` is mapped to an
   `ActorContext` by core via `actorContextFromEvidence`
   (`packages/core/src/runbook/actor-context.ts`). Front ends never construct a
   final `ActorContext`; they describe who is calling and what they can prove.
   The mapping is evaluated against an `EvidenceTarget` — the resolved run's id
   plus its **delegation exposure**, classified at decision time by
   `classifyDelegationExposure`
   (`packages/core/src/runbook/delegation-exposure.ts`). A run is `delegating`
   iff any of six clauses holds: (a) its document authors a DELEGATE substep
   (static — protection starts before any issuance); (b) it has open claimed
   children; (c) it has reported-but-uncollected delegation outcomes; (d) any
   substep state carries a delegation record (sticky history — exposure never
   decays after claims close); (e) it carries parent linkage (inline or
   delegation); (f) it composes children inline — statically, any substep
   carries runbook-list entries, or at runtime any substep state carries an
   inline launch record (sticky, like d). Only a `standalone` run (all six
   clauses fail) keeps the bare `direct_cli` convenience lane; on any
   delegation-exposed target the only trust-granting evidence is a verified
   bearer claim (`--claim-id`). A `--run <rd_…>` id is a target selector only,
   never authority — it selects which run a mutation addresses but authorizes
   nothing. Two consistency caveats are deliberate: (i) the document-derived
   clauses (a and f's static signal) are re-parsed at decision time, so a
   mid-run edit of the runbook document can flip a not-yet-issued run's static
   exposure — the state-derived clauses are monotone and never decay; (ii)
   exposure classification and target resolution are two lock-free reads, and
   the design stays fail-closed because trust is bound to the classified run's
   id: `deriveEffectiveRole` refuses an id mismatch with the resolved target, so
   an interleave (e.g. an inline child popping between the reads) can never
   transfer one run's trust onto another.
2. **Target resolution + policy.** `resolveTransitionTarget` resolves the target
   run and runs strict target-relative policy, returning typed refusals (`none`,
   `stale_claim`, `terminal_claim_confirmed` / `terminal_claim_conflict`,
   `open_delegated_children`, `delegation_collection_pending`,
   `actor_context_required`). These are surfaced as `LifecycleTransitionOutcome`
   variants that reuse the resolver's shapes so payloads (the
   `DELEGATION_COLLECTION_PENDING_MESSAGE` literal, claim ids, the
   confirm/conflict split) are preserved by construction.
3. **Single resolution + in-seam step derivation.** The seam resolves the target
   exactly once and derives that run's parsed steps in-seam via the injected
   `loadSteps(state)` dependency, instead of taking `steps` as an input the
   front end would have to resolve first. Step derivation is parsing of the
   resolved state's in-memory `runbookSrc` plus an environment-bound
   helper-registry + render context (Category A), not runbook-file IO.
4. **Drive the machine, preserving the two mutation paths.** The seam keeps the
   split it inherited and does not collapse it to an unconditional
   `sendAndSync(PASS|FAIL)`:
   - **manual substep completion** (`#driveSubstep`) records via
     `RunbookCompletionService.recordManualCompletion` and drains resolved
     completions;
   - **top-level run transition** (`#driveTopLevel`) sends `PASS` / `FAIL`
     through `RunbookActorService.sendAndSync`.

   Both decisive bare default-target advances run inside
   `SessionService.runGuardedParentAdvance` (the TOCTOU guard), and both apply
   terminal release per the `LifecycleTerminalReleasePolicy`.

5. **Bare inline-child reactivation.** When a bare (no `manualTarget`) substep
   transition lands on a substep whose inline child is still running and whose
   parent linkage matches, the seam resumes the child via
   `SessionService.pushRunbook` rather than recording a completion. This
   decision ("is the child still open?") is runbook logic, so it lives in core
   (`#reactivateRunningInlineChild`), not in the CLI. The explicit `--step` /
   `--index` path never reactivates — it is a deliberate completion against a
   named substep.

   The seam also decides whether the reactivation needs the parent's execution
   loop, and returns that as the loop directive. An **interrupted** launch does:
   the launcher records `startedAt`, consumes the one-shot launch intent and
   re-establishes the child's run-control authority
   (`SessionService.adoptRunControlClaim`) in one continuation, and a process
   that died mid-launch leaves all three undone. Only the launch seam
   (`launchInlineChildFromIntent`'s existing-child branch) performs them, and
   only the parent's own loop reaches it, so the seam returns
   `loop: { kind: 'run' }` there. A launch that already **finished** returns
   `loop: { kind: 'none' }` — running the loop would re-enter an execution unit
   the parent never left, re-announcing the step and re-running any command it
   carries. The discriminant is the surviving intent itself
   (`#hasUnconsumedInlineLaunchIntent`), which is the same value
   `observeExecutionUnitEntry` re-projects, so the seam's decision and the
   loop's behaviour agree by construction.

The seam returns transition-observation events plus a loop-continuation
directive (`LifecycleLoopDirective`) as **data**. It does not spawn processes or
render.

### What the direct CLI owns

The direct CLI is a thin front end over the seam. It performs only Category-A
work:

- **gathers native caller evidence** — `readLifecycleCallerEvidence`
  (`packages/cli/src/helpers/caller-evidence.ts`) returns
  `{ kind: 'claim_bearer', claimId }` for `--claim-id`, and
  `{ kind: 'direct_cli' }` for everything else. A `--run <rd_…>` id is **not**
  evidence — it is parsed separately as a target selector, not caller authority.
  The helper no longer decides whether a bare invocation grants anything — core
  does, from the target's delegation exposure;
- **parses `--run`** — `parseRunOption`
  (`packages/cli/src/helpers/run-option.ts`) validates the id format via core's
  `isRunId` and enforces mutual exclusion with `--claim-id` (Category-A flag
  parsing only; a `--run` id is threaded through as the target selector and
  resolved against the session `defaultStack` in core — it never becomes caller
  evidence);
- **parses `--step` / `--index`** into a pre-resolved `ManualCompletionCursor`
  via `resolveManualCompletionCursor`
  (`packages/cli/src/helpers/transitions.ts`) — raw-argument input handling on
  inherently external CLI args (Category A);
- **renders the seam's typed outcome** to the existing JSON/text envelopes and
  maps it to exit codes (including the post-transition parent-propagation
  block);
- **runs the execution loop** (command-step subprocess spawning) per the
  returned `loop` directive.

The CLI constructs **no** `ActorContext`.

### Source tagging is not trust

`ActorContext` has no `source` field. Source tagging is not a trust mechanism:
there is no `--actor-source` flag and no `RD_ACTOR_SOURCE` env var, and they
must not be reintroduced. The only trust-granting evidence is a verified bearer
claim id. Everything that is not a verified bearer claim — `direct_cli`
evidence, the legacy non-authoritative `run_controller` / shape-only `claim`
shapes, and any `plugin` or `mcp` framing — maps to `UNKNOWN_ACTOR_CONTEXT`,
along with any agent id, session id, run id, or tool name they carry.

### Terminal authority requires a bearer claim; `--run` only selects the target

A terminal command (`complete` / `stop`) mutates only when it carries a verified
bearer claim (`--claim-id`). `--run <rd_…>` names which run the terminal
addresses; it grants nothing. A `--run`-only terminal on a delegation-exposed
run is refused with `ACTOR_CONTEXT_REQUIRED`, exactly like a bare one — a run id
is an identifier, not authority.

The claim's authority still composes over a **contiguous inline composition
chain**: the chain walk climbs `parentLinkage.kind === 'inline'` to the root the
member belongs to, so a claim that controls the root reaches every inline member
launched under it in-session. Two independent walls keep this bounded: a claimed
child's run is never a `defaultStack` member (so `--run` cannot resolve it as a
target), and the chain walk climbs only inline linkage, so a **delegation
boundary always severs the chain**. Pinned by the seam tests in
`transitions-seam.test.ts`.

### Guards do no cross-run IO or policy

Cross-run IO and policy stay in the seam and `resolveTransitionTarget`, never in
XState guards. Guards express per-run domain conditions; they do not read other
runs' state, resolve claims, or evaluate command policy. Keeping that work in
the seam is what lets the state machine remain a pure per-run program.

### Plugin / MCP are not direct-CLI-trusted callers

The plugin and MCP server reach the CLI by spawning a subprocess, so typed
`CallerEvidence` cannot cross that boundary — a spawned `rundown pass` arrives
as an ordinary `argv`, indistinguishable from a human invocation. They are
therefore **not** direct-CLI-trusted callers.

**Core is the primary gate.** Since R1, core itself refuses ambient direct-CLI
trust on every delegation-exposed run (the exposure-conditional `direct_cli`
mapping above), so the subprocess withhold set is **defense-in-depth**, no
longer the primary protection. Its remaining job is to stop a spawned bare
mutation from silently consuming the standalone-run convenience lane and to keep
refusals front-end-rendered (a clear typed withhold instead of a downstream
policy error). The shared boundary `bareRoleSpecificMutation`
(`packages/core/src/runbook/subprocess-mutation-boundary.ts`) classifies a bare
(default-target) `rundown pass` / `rundown fail` / `rundown goto` /
`rundown delegate` / `rundown complete` / `rundown stop` / `rundown collect` as
the invocations whose only available trust is `direct_cli`; the spawning front
end withholds those.

**Only the claim lane passes through.** `--claim-id` mutations are preserved:
their `claim_bearer` evidence (`claimId`) is reconstructable CLI-side from the
resolved claim record, so `carriesClaimEvidence` classifies them as authorized
and the spawning front end forwards them. A `--run <rd_…>`-only mutation is
**not** a second lane — because `--run` is a target selector and not authority,
such an invocation is classified bare and withheld exactly like a flagless one.
There is no `carriesExplicitRunTarget` counterpart to `carriesClaimEvidence`.
The MCP mutating tools still expose an optional `runId` parameter mapped to
`--run` argv for target selection, but a run id alone never authorizes the
mutation; a bearer claim must accompany it on a delegation-exposed run. See
[Claude Code Plugin Trust Model](./plugin-trust-model.md) for the plugin's other
trust boundaries.

### A claim-shaped target is the same fact as its bearer

`runTransition`, `runTerminal`, and `resolveRunNavigation` each take caller
evidence and a target selector as separate inputs. When the selector is
claim-shaped these are **not** independent: a claim id carries its own live
secret segment, so naming one is an act of presentation, not merely of
selection. The only consistent combination is "the caller presented the bearer
it named".

Each seam reconciles the two at entry, before resolving anything from the claim,
and refuses `CLAIM_BEARER_MISMATCH` otherwise. Without that gate the seams
derived their actor context from the **target's** verified claim and so acted as
the target while the caller's evidence said something else — authorizing on
authority the caller never demonstrated it held.

The refusal is deliberately separate from `ACTOR_CONTEXT_REQUIRED`. That code
means no authority was named at all and its remediation is to supply
`--claim-id`; here the caller supplied one, so reusing it would tell the caller
to do the thing it already did. The envelope names neither claim — the refusal
precedes resolution, so there is no verified claim record to reduce to a
non-secret `claimKey`, and echoing a raw `claimId` would write a bearer secret
to output.

No CLI path can provoke it: `--claim-id` populates both fields at all three call
sites. It is a seam contract for programmatic frontends, and it is fail-closed
by construction rather than by convention.

### Refusal messages never echo the target run id

The `ACTOR_CONTEXT_REQUIRED` refusal tells the caller to pass
`--claim-id <claimId>` using the bearer claim from their orchestration context,
and deliberately does **not** echo the target run id in the message or the JSON
details. A run id is only an identifier and would authorize nothing even if
echoed, but surfacing it would still hand the lingering-child agent a copy-paste
target it can pair with a stolen claim, so the barrier stays quiet about it. Run
ids remain natively present elsewhere — in claim output (`parent_run_id`), on
every event (`runbookId` — an inline child's id also rides the `inlineLaunch`
**payload** on the launch event; there is no event type named `inlineLaunch`),
and via `rundown status` — but a run id is a selector, and only a verified
bearer claim authorizes a mutation.

### Credential disclosure boundaries and RD-821

Delegation tokens are derived, not stored: persisted state holds a non-secret
`DelegationCredentialDescriptor` plus a `tokenHash`, and the bearer is
reconstructed on demand by a deriver bound to the exact issuing claim
(`createDelegationTokenDeriver`). That deriver refuses a descriptor naming a
different `issuerClaimKey`, so every surface that hands a raw bearer back to a
caller can fail for one of two reasons: the presenting claim is not the issuing
claim, or the reconstructed token does not hash to the verifier the parent
recorded at issuance. Both are refusals, not successes with a degraded value —
neither arm returns a token.

There are three such disclosure boundaries, and all three refuse under one error
code, `RD-821` (`DELEGATION_INVARIANT_VIOLATED`):

| Boundary                                                             | Surface                                                                                                                                     |
| -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `issueDelegation`'s same-issuer echo (`verifyEchoedDelegationToken`) | The seam returns `{ kind: 'error' }`; `rundown delegate` throws it into the wrapper, which emits `{"kind":"error","code":"RD-821"}`         |
| The CLI execution loop re-entering a persisted `delegateFrontier`    | `projectDelegateFrontier` throws; the seam catches, emits `ERROR_OCCURRED` with `code: 'RD-821'`, releases the run, and returns `'stopped'` |
| `rundown collect` re-entering a persisted frontier                   | Returns `collection_failed` with `reason: 'frontier_projection_refused'` and `code: 'RD-821'`                                               |

The last two rows share one **disclosure boundary** — the same reader, the same
projector, and the same refusal arm — in two seams that differ only in when the
consume commits. Both live in `packages/core/src/runbook/re-entry-frontier.ts`,
and each frontend contributes only its rendered `StepEntryMetadata`, its emitter
wiring, and its exit-code mapping.

| Seam                               | Driver             | Consume                                  | Arms                                                              |
| ---------------------------------- | ------------------ | ---------------------------------------- | ----------------------------------------------------------------- |
| `projectAndConsumeReEntryFrontier` | `runExecutionLoop` | Committed by the seam, via `sendAndSync` | `none` / `projected` / `projection_refused` / `consume_failed`    |
| `prepareReEntryFrontierConsume`    | `rundown collect`  | **Derived**, committed by the caller     | `none` / `projected` / `projection_refused` — no `consume_failed` |

The unfenced seam commits the consume **before** returning observations, so a
failed consume discloses no bearer. The fenced twin cannot observe until the
caller's single transaction has landed, which strengthens the same guarantee:
where the unfenced seam can leave a consume committed while the surrounding work
is not, a refused transaction consumes nothing and discloses nothing.

That is why `consume_failed` has no fenced counterpart. A derivation cannot
half-commit, so the only way a collect's consume does not land is that its
enclosing transaction refused — reported as the transactional refusal, with the
frontier likewise untouched and the operation retryable. `RD-829`
(`DELEGATION_FRONTIER_CONSUME_FAILED`) therefore has exactly one producer today,
the execution loop; `DelegationPolicyOutcome` carries no
`frontier_consume_failed` reason, because nothing could construct it.

Three consequences worth stating explicitly.

**RD-821 is now operator-reachable.** It was introduced as an unreachable-branch
guard — `retryDelegation`'s exhaustiveness default still uses it that way — and
its registered description in `errors/codes.ts` has been updated to name the
operator-reachable cause. All three rows are ordinary operator conditions rather
than internal inconsistency: rotate the run-control claim between issuance and
disclosure and the surviving descriptor names a claim nobody can present.

**It is deliberately not `ACTOR_CONTEXT_REQUIRED`.** On these paths authority is
present — it is simply the wrong authority — so the absent-authority code would
name the wrong condition and its remediation ("pass `--claim-id`") would tell
the caller to do the thing it already did. Where authority is genuinely absent —
the execution loop reaching a pending frontier with no deriver — the loop does
refuse `ACTOR_CONTEXT_REQUIRED`, and stops with
`reason: 'actor_context_required'`, the same reason the machine's own
`delegationIssueActor` produces for the issuance half of that condition.

**The code follows the condition, never the command.** `collect` previously
reported a refused projection under `COLLECT_OPERATION_FAILED` — its own
surface's registered code — with the distinguishing detail only in `reason`.
That made one fact two codes depending on which command drove the seam, and it
overloaded a code whose contract is "collection failed while applying delegation
outcomes" onto a case where nothing was applied. `COLLECT_OPERATION_FAILED` now
covers only a drain target mismatch.

The frontier's other failure is a different fact and keeps its own code:
**RD-829** (`DELEGATION_FRONTIER_CONSUME_FAILED`) means projection succeeded and
the `DELEGATE_FRONTIER_CONSUMED` sync did not. It is retryable — the frontier is
still persisted and no observations were surfaced — whereas
`frontier_projection_refused` is not fixed by repetition, since the same
authority refuses identically. Two codes because the remediations invert; RD-826
through RD-828 belong to the retry idempotency contract
(`DELEGATION_REPLACEMENT_CONSUMED`, `DELEGATION_RETRY_IDENTITY_UNMATCHED`,
`DELEGATION_SUPERSESSION_AMBIGUOUS`), so the frontier code takes RD-829.

RD-829's producer set narrowed when collect became transactional: it is now
reachable only from the execution loop, which still commits its consume
separately. A fenced collect derives the consume inside its one transaction, so
the condition cannot arise there (see the seam table above), and the
`frontier_consume_failed` reason was removed from `DelegationPolicyOutcome`
rather than retained without a producer.

The fail-closed remedy the credentials design prescribes for a rotated issuing
claim — explicit cancel and reissue — has no path today, because
`abortDelegation` opens with `findDelegationByToken` and is therefore located by
bearer only: cancelling needs the bearer, and producing the bearer needs the
rotated-away claim. This is latent rather than live — the only production
run-control mint is `pushRunbookWithPreparedRunControlClaim` at launch, and
`issueRunControlClaim` / `pushRunbookWithRunControlClaim` have test-fixture
callers only, so nothing rotates a run-control claim yet. It is recorded as an
open design question in the PR 12 review-remediation addendum.

### Residual ambient session-management lane (R1 scope decision)

`stash`, `pop`, `prune` (including `--all`), `abort`, `claim`, and `status`
remain ungated by delegation exposure. A bare `stash` can pause a delegating
pipeline, a bare `pop` can reorder the stack, and `prune --all` can destroy live
run state — ambient session-management disruption/DoS, but **not** run-driving
takeover: none of these can advance, complete, or delegate on behalf of the
orchestrator, which is the defect class R1 closes. Gating session management
behind exposure is follow-up work tracked outside this document.

### Lifecycle write diagnostics

Every persisted write that changes `RunbookState.lifecycle` — and every
run-state deletion — emits a `logger.debug('lifecycle-write', …)` line from the
two persistence chokepoints, `RunbookStateManager.save` (transitions, including
creation as `null -> running`) and `RunbookStateManager.delete`. All state
mutators funnel through these two methods, so every writer — actor snapshot
sync, the lifecycle command seam, collection drain, plugin-hook-spawned CLI
processes, `cleanupOrphanedActiveStack` — is covered regardless of caller.
Enable with `RUNDOWN_LOG_LEVEL=debug`; the logger stamps pid.

The delete trail is emitted after the row delete commits and **before** the
per-run outputs directory is removed, so a later `fs.rm` failure cannot suppress
the record of a deletion that actually happened. The row delete cascades to
claims, stack, stash, completions, and attempts, and refuses while an execution
owns the run.

This is deliberately a debug signal, not a durable subsystem: the forensic
instrumentation that root-caused #536 (pid/ppid/argv/call-site records in an
append-only file) was scaffolding, removed once the writer was identified.
Durable, domain-level attribution of mutations is the province of the claim-id
and caller-evidence model (see the delegation-lifecycle roadmap's explicit
targeting work) — identity is named by the caller, not reconstructed from
process metadata. If an unattributed-writer class of bug ever reappears,
re-instrument from git history rather than re-deriving.

---

## State Persistence and Concurrency

Run, session, and claim authority live in **one SQLite database per project**,
`.rundown/rundown.db`. Nothing else is authoritative: there is no per-run JSON
state file, no separate session file, and no file lock guarding either. The one
piece of run-adjacent state outside the database is **captured filesystem
output**, which stays under `.rundown/runs/<run-id>/outputs/`
(`outputsDirForRun`, `packages/core/src/runbook/output-channels.ts`) because it
is arbitrary user data, not authority.

For the normative operator-facing contract — storage locations, the two version
checks, the no-migration rule — see
[docs/reference/runtime.md § State Persistence](../reference/runtime.md#7-state-persistence).
This section describes the implementation behind it.

### One store, one opener

`packages/core/src/runbook/storage/store-registry.ts` is the sole authoritative
open path: `new RunbookStore(...)` is constructed in exactly one place, inside
`openRunbookStore`. The registry keys open stores by project root, so every
service in a process shares one driver and one connection. Legacy-state refusal
happens in that opener, before the database is created, so an incompatible
project can never get a half-initialised store.

Schema installation is `ensureSchema` (`storage/schema.ts`): it stamps
`PRAGMA user_version` with `SCHEMA_VERSION` on a fresh database, no-ops on a
matching one, and throws `IncompatibleSchemaError` on anything else. It never
migrates. Because the DDL and the constant live in the same file, **any DDL edit
must move `SCHEMA_VERSION`** — the file says so at its head, having already been
bitten once by a widened `CHECK` that shipped without a version bump.

Six tables carry everything: `runs`, `claims`, `session_stack`, `stash_slot`,
`resolved_completions`, `execution_attempts`.

### Two schema versions, deliberately distinct

They are separate mechanisms with separate failure modes, and conflating them is
a documented mistake:

| Version                      | Governs                                                                            | Where it lives                     | Rule                                        |
| ---------------------------- | ---------------------------------------------------------------------------------- | ---------------------------------- | ------------------------------------------- |
| SQLite storage schema        | The whole database — runs, session, stash, claims, attempts                        | `PRAGMA user_version`              | Must equal `SCHEMA_VERSION` (currently `2`) |
| `RunbookState.schemaVersion` | One run's structured state fields and its opaque `snapshot` blob, and nothing else | The run row's persisted state JSON | Must be exactly `1`                         |

A wrong storage version invalidates the whole database (`RD-305`); a wrong
`RunbookState.schemaVersion` invalidates **only that run** (`RD-309`). Session,
stash, and claim rows carry no `schemaVersion` of their own. Neither version is
ever migrated, hydrated, shimmed, or dual-read — the recovery path is always
explicit user action.

### Drivers: two implementations, one atomicity bar

`storage/driver-factory.ts` selects the driver, and the selection is
fail-closed:

- **`node:sqlite` (native)** everywhere real multi-process concurrency exists.
  The database is opened in WAL mode with `PRAGMA busy_timeout = 5000` and
  `PRAGMA foreign_keys = ON`; every write runs as a short `BEGIN IMMEDIATE` with
  explicit rollback, plus a bounded application-level retry (10 retries after
  the first attempt, backing off `25ms × attempt`) for the `SQLITE_BUSY` that
  escapes the busy timeout. `BEGIN IMMEDIATE` rather than deferred is
  deliberate: it converts a mid-transaction upgrade failure into an entry-point
  one the retry loop can handle. If native SQLite cannot initialise, the factory
  raises `NativeSqliteUnavailableError` — it does **not** fall back.
- **`sql.js` (WASM)** only inside WebContainer, identified positively by the
  `jsh` shell marker. Forcing it anywhere else raises
  `SqljsUnsupportedHostError`, because the adapter is single-writer and would
  reintroduce the hazard the native driver rules out.

**The atomicity bar is identical on both drivers.** `sqljs-driver.ts` issues a
plain `BEGIN` rather than `BEGIN IMMEDIATE`, but exclusion does not come from
the SQL verb: it comes from `runLocked`, which serialises each critical section
behind an in-process mutex and an advisory file lock, and from the load →
`BEGIN` → work → `COMMIT` → durable-export → close cycle running entirely inside
that lock. More importantly, the property that matters — **claim
compare-and-swap before any write, in the same transaction** — lives in
`commitOwnedRunSet` / `classifyCommitRow`, not in either driver. Do not record
this as "the bar holds only on native"; that reading would misdirect a future
WebContainer audit.

Where the two genuinely differ is the multi-process guarantee, and that
difference is confined by construction: the sql.js adapter declares
`capabilities.multiProcess: false`, and `driver-factory.ts` only ever selects it
on a host that is single-writer anyway.

Both drivers take **synchronous** transaction callbacks (`SyncWork`, enforced at
runtime by `assertSyncWorkResult`). That type is load-bearing: it makes it
structurally impossible to hold a transaction open across an awaited external
effect, which is what forces the effect fence below to be three transactions
rather than one.

### The decisive commit: CAS first, write after

The atomicity bar for a mutation is: **one decisive `BEGIN IMMEDIATE`
transaction whose first act is a claim compare-and-swap, with a refusal rolling
back having written nothing authority-bearing.**

`classifyCommitRow` (`storage/runbook-store.ts`) is the total classifier that
encodes the ordering, and the order is the contract:

1. **Existence** — run gone → `missing`.
2. **Claim validity** — claim absent, not controlling this run, or not `active`
   → `claim_superseded`.
3. **Claim generation** — moved since capture → `claim_superseded`.
4. **Delegated-parent liveness** — parent missing, terminal, or relinked →
   `claim_superseded`.
5. **Lost update** — `state_version` moved → `concurrent_modification`.
6. **Execution identity** — the owning attempt is not the expected
   `(epoch, token)` tuple → `execution_in_progress` / `recovery_required`.

A zero-row `UPDATE` cannot distinguish "run gone" from "generation moved", which
is why the classifying `SELECT` decides and the `UPDATE` merely applies.

`commitOwnedRunSet` extends this to a run **set** without weakening it: it
classifies **every** member before writing **any**, then writes in
caller-supplied dependency order (descendants before roots before external
parents), then applies the optional session projection last — by which point
every affected execution owner has already been cleared, so no trigger-guarded
session write can be refused by the owned-run guard. One member's moved
generation refuses the whole set with nothing written.

Ownership is cleared in the _same_ `UPDATE` that writes `state_json`. There is
no window in which state is committed but the run still reads as owned.

### What the schema enforces on its own

Triggers, not application code, are what make the CAS unbypassable:

- **Owned-run guards.** While `runs.exec_token IS NOT NULL`, any claim or stash
  insert/update/delete `RAISE(ABORT, 'execution_in_progress')`. The store
  normalises that abort into the typed refusal, matching on the exact string.
- **Generation bumps.** Any claim or stash mutation bumps
  `runs.claim_generation`, invalidating every authority captured before it. Any
  `state_json` write bumps `runs.state_version`.
- **The liveness exception.** Both claim `UPDATE` triggers are scoped
  `UPDATE OF` nine resolution-affecting columns, deliberately **excluding
  `last_seen_at` and `updated_at`**. That exclusion is what lets a
  claim-liveness touch be recorded while an owner holds the run without either
  being refused or invalidating captured authority. It is the reason "nothing
  written" on a refusal is stated as **nothing _authority-bearing_ written**:
  every mutating path commits an inert `recordClaimSeen` row in its own
  transaction beforehand, by design, so a failed liveness write can never roll
  back the collection and a refused collection can never lose the liveness
  record. The rationale is recorded in `collection-service.ts` at
  `recordPresenterLiveness`.
- **Partial unique index.**
  `claims_one_active_per_run … WHERE status = 'active'` makes "the run's
  controlling claim" a function rather than an arbitrary pick.
- **Execution identity is all-or-nothing.** A `CHECK` on `runs` requires
  `exec_epoch`, `exec_pid`, and `exec_token` to be present together or absent
  together, so a half-populated identity — an owner recovery cannot resolve — is
  unrepresentable.

Claims are tombstoned, never hard-deleted: a claim that leaves the session
becomes `status = 'superseded'` so issuance history survives.

### Execution leases and the effect fence

"One transaction" applies to the **decisive write only**. A mutation that has an
external effect cannot hold a transaction across it — the `SyncWork` type
forbids it — so the real shape is **one decisive commit behind a
three-transaction lease fence**, driven by `CoreEffectfulMutationExecutor`
(`effectful-mutation-executor.ts`) and `effectful-actor-mutation-runner.ts`:

| Stage                                    | Transaction | Purpose                                                                   |
| ---------------------------------------- | ----------- | ------------------------------------------------------------------------- |
| Capture authority + state                | read        | Snapshot `state_version`, `claim_generation`, and parent linkage together |
| `acquire` / `acquireAll`                 | write       | Take exclusive execution ownership; insert the attempt at phase `claimed` |
| `markEffectStarted(All)`                 | write       | Move to `effect_started` **before** the effect runs                       |
| The effect                               | none        | `compute` runs outside any transaction and may await                      |
| `commitOwnedState` / `commitOwnedRunSet` | write       | The decisive commit: CAS, then write, then clear ownership                |

`execution_attempts.phase` is a closed union — `claimed`, `effect_started`,
`recovery_pending`, `committed`, `released` — validated at every read edge by
`assertExecutionPhase` and again by a DDL `CHECK`. `committed` and `released`
are terminal and are deliberately distinct: conflating them would let a released
attempt read as a durable commit.

Marking `effect_started` before the effect is the whole point of the fence. A
process that dies during `compute` leaves an `effect_started` attempt, which
recovery moves to `recovery_pending` rather than silently re-running.

**Aggregate acquisition is all-or-none.** `acquireAll` runs one transaction and
throws an internal rollback marker on the first refusing member, so a partial
failure leaves no attempt rows and no `runs.exec_*` writes; the caller sees the
first refusing run's discriminant. `markEffectStartedAll` and
`abandonAllToRecovery` use the same shape. The executor layers an
`optionalRunIds` policy on top: an optional member that refuses is dropped and
the acquisition retried, rather than failing the aggregate.

### There is no exactly-once-effect guarantee

The fence guarantees **at-most-once**, not exactly-once. Its stated
non-negotiable rule is that _an ambiguous external effect is never automatically
repeated_:

- An ambiguous failure after the effect boundary abandons the attempt to
  `recovery_pending` and returns `recovery_required`. The effect is not retried.
- A commit that throws is not converted into a refusal, because
  `commitOwnedState` moves the same `(run, epoch, token)` tuple to `committed` —
  so the refusal would conflate "another actor is recovering" with "we committed
  durably and lost the response". Reporting the latter as "did not happen" would
  invite exactly the retry the fence forbids, and a durable commit clears
  ownership, so that retry would acquire a fresh attempt and re-run the effect.

The one idempotency primitive is at the commit layer, not the effect layer:
`isExactAttemptCommitted` probes `phase = 'committed'` for the exact
`(run_id, exec_epoch, exec_token)`, letting a re-observed commit short-circuit
as `committed`. That is what makes the executor's reconciliation retry safe —
the probe distinguishes a durable prior write from a genuine refusal. `compute`
is never re-run on any of these paths.

Recovery itself is machine-owned and effect-free.
`ExecutionRecoveryService.recover` rehydrates an actor from the persisted
snapshot and sends exactly one pure event,
`EXECUTION_OUTCOME_UNKNOWN { epoch, reason, interruptedStepId }`. Its actor
factory is contractually required to compile the machine with inert command,
delegation, and helper implementations, so the original effect path cannot be
re-entered. Recovery is **automatic**: when the fence returns
`recovery_required`, the runner drives recovery inline, in the same process and
the same call, for the exact epoch the refusal named — there is no
`rundown recover` command, and none is needed. Recovery unblocks the run's
state, but the command's own outcome stays `recovery_required`: the caller is
told the mutation did not happen, which is true.

### PID-identity recovery, and its two known weaknesses

`recoverDeadOwner` decides whether an owning process is still alive by
evaluating `isProcessAlive(owner.execPid)` **outside** SQLite and then
protecting the decision with an exact-tuple CAS on
`(run_id, exec_pid, exec_token, exec_epoch)`. A dead owner still in `claimed`
has its lease reclaimed and its attempt closed as `released`; a dead owner past
`effect_started` is moved to `recovery_pending`. If the CAS matches nothing the
result is `alive` (pre-effect) or `unresolved` — never a steal, on the principle
that another process may have reissued the lease between the read and the CAS.

Two weaknesses are worth stating plainly, because both are latent rather than
theoretical:

1. **Owner identity is PID-only in practice.** `runs.exec_start_id` and
   `execution_attempts.owner_start_id` are declared and `CHECK`-constrained, but
   every production write sets them NULL — the acquisition `UPDATE` does not
   list them at all. The process-start-id disambiguator the schema reserves is
   therefore inert, so a **reused PID is indistinguishable from the original
   owner**. `isProcessAlive` compounds it by design: only `ESRCH` proves death,
   and every other error (including `EPERM`) returns "alive", so the bias is
   safe against theft and unsafe against stranding. The failure mode is a
   permanent stall, not a lost mutation.
2. **The dead-owner path has no production caller today.** `recoverDeadOwner` is
   reached only from `withWait`, which returns before it unless a
   `LeaseWaitPolicy` was supplied — and nothing in `packages/*/src` constructs
   one. In practice a hard-killed owner leaves `runs.exec_token` set, and
   subsequent commands refuse `EXECUTION_IN_PROGRESS` until the state is pruned.
   The in-process paths (`releaseClaimed`, `releaseEffectStarted`,
   `abandonToRecovery`) cover every failure the executor itself observes; it is
   only the SIGKILL case that is uncovered.

### Optimistic CAS: `mutateState` is not a lock

`RunbookStore.mutateState` is the claim-free read-modify-write that replaced the
per-run file lock, and **it does not behave like one**. It reads
`state_version`, runs the caller's `build` outside any transaction, and commits
only if the version is unchanged and the run is unowned. On a moved version it
replays the whole cycle — at most **8 attempts, with NO backoff**, so all eight
can land within a few milliseconds. A few-way concurrent writer then exhausts
the budget and the call returns `concurrent_modification`, which surfaces to the
user as a command failure (`CONCURRENT_MODIFICATION`, or `RD-308` when it
escapes through the throwing seam) where the deleted lock would have blocked and
won.

Two consequences bind callers:

- `concurrent_modification` is a **reachable** arm on any path that can be
  driven concurrently. Handle it or retry it; never document it as theoretical.
- `build` runs **once per attempt** and MUST therefore be free of external side
  effects. Only the final committed return value is persisted; nothing unwinds
  what a losing attempt did elsewhere.

Note the CAS asymmetry: `mutateState` guards on `state_version` only, **not** on
`claim_generation`. A claim revoked between an out-of-band authority check and
this commit is invisible to it. That is sound for its claim-free contract, but a
`committed` result is **not** evidence that the caller's authority was still
valid at commit time — a write that must be claim-guarded goes through
`saveState` / `commitOwnedState` instead.

By contrast, transaction contention on `mutateSession` and every other
`BEGIN IMMEDIATE` write **does** block like the lock did, via
`busy_timeout = 5000` inside SQLite plus the native driver's bounded retry.

### Two domain locks survive, as tracked debt

The single-store plan called for deleting all four core domain locks.
`SessionLock` and `RunStateLock` are gone; **`CompletionLock` and
`DelegationLock` are not**, and they remain wired at exactly six production call
sites:

| Lock             | Site                                                                           |
| ---------------- | ------------------------------------------------------------------------------ |
| `CompletionLock` | `completion-service.ts` — `recordManualCompletion`, `drainResolvedCompletions` |
| `DelegationLock` | `completion-service.ts` — `recordChildCompletion`                              |
| `DelegationLock` | `packages/cli/src/commands/run.ts` — run-start `afterInit`                     |
| `DelegationLock` | `packages/cli/src/services/execution.ts` — inline launch                       |
| `DelegationLock` | `packages/cli/src/helpers/runbook-pipeline.ts` — claim-and-launch              |

This is a **tracked deviation**, followed up in #690 (which also owns the
`DELEGATION_LOCK_TIMEOUT` / RD-810 error surface outliving them). Until it
closes: do not add consumers of either lock, and do not read their survival as
licence to put new run or session state behind a file lock. The remaining
legitimate uses of `file-lock.ts` are the artifact manifest and the sql.js
driver's own durable-replacement critical section.

Where a lock is still held, its release is scoped with `await using` and is
best-effort and non-propagating (RD-102): a failed unlink leaks only a
self-healing lock, reclaimed by the next acquirer via PID-aware stale detection,
and must never replace the committed outcome of the work it protected. Releasing
a domain lock from a bare `finally` is the RD-102 masking defect.

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
