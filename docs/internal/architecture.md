# Rundown Internal Architecture

This document describes Rundown's implementation architecture: the state machine
design, core abstractions, design principles, and internal subsystems. For the
CLI user reference, see [docs/reference/cli.md](../reference/cli.md). For the
execution model and runtime semantics, see
[docs/reference/runtime.md](../reference/runtime.md). For generic XState v5 +
TypeScript patterns, see [xstate-patterns.md](./xstate-patterns.md).

---

## Architecture Overview

The Rundown system separates concerns into three layers:

| Layer             | Component               | Responsibility                                                     |
| ----------------- | ----------------------- | ------------------------------------------------------------------ |
| **Format**        | `.runbook.md` files     | Runbook definition (steps, transitions, commands)                  |
| **State Machine** | XState-compiled machine | State transitions and guards                                       |
| **Persistence**   | JSON files              | Runbook state survives context clears                              |
| **Iteration**     | Machine-owned actors    | Per-iteration data source value resolution and machine transitions |

The CLI is an orchestration and control interface. Claude executes the actual
work.

```text
[Runbook File] --> [Parser] --> [XState Machine] --> [State Manager]
                                       ^                    |
                                       |                    v
                              [CLI Commands] <---- [Persisted JSON]
```

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
child state file. `abort --force` can also cancel the resolved linked delegation
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

---

## CLI ↔ Core Event Boundary

The CLI and core packages communicate through a typed event boundary. Two flows:
events the CLI sends into the machine, and observable events the CLI renders by
translating snapshot transitions.

### Events the CLI sends into the machine

| Event                                                                          | Source                                                          | Notes                                                                                                                             |
| ------------------------------------------------------------------------------ | --------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `PASS` / `FAIL`                                                                | `rundown pass` / `rundown fail` STDIN, substep-completion drain | Only from external user actions or pre-persisted completion records. The CLI MUST NOT synthesise these from internal observation. |
| `GOTO { target }`                                                              | `rundown goto`                                                  | Jumps. `target` is a `StepId`. The CLI's `--index` flag is resolved before dispatch; the event itself carries no index field.     |
| `RETRY`                                                                        | (internal — generated by retry transitions)                     |                                                                                                                                   |
| `SET_VARIABLES { vars }`                                                       | Delegation completion                                           | Used when a child runbook reports back.                                                                                           |
| `DELEGATE_FRONTIER_CONSUMED`                                                   | Delegation issuance                                             | Acknowledges the front end emitted the auto-issued delegation frontier.                                                           |
| `INLINE_CHILD_STARTED { parentStepId, parentFrameKey, childRunId, startedAt }` | Inline launch side effect                                       | Records that the front end has created and started the inline child runbook for the machine-owned intent.                         |
| `INLINE_LAUNCH_CONSUMED`                                                       | Inline launch side effect                                       | Clears the one-shot `inlineLaunchIntent` after the front end has consumed it.                                                     |

The set is small and stable. New CLI subcommands dispatch into existing events;
they do not introduce new events without a corresponding state-machine handler.
Transitional events introduced during incremental migrations (e.g. an event that
bridges a CLI-owned side effect to a machine-owned one before the side effect
itself moves into the machine) are scoped to the migration window and removed
once the boundary collapses — they do not become permanent fixtures of the
protocol.

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
two persistence chokepoints, `RunbookStateManager.saveUnlocked` (transitions,
including creation as `null -> running`) and `RunbookStateManager.delete`. All
state mutators funnel through these two methods, so every writer — actor
snapshot sync, the lifecycle command seam, collection drain, plugin-hook-spawned
CLI processes, `cleanupOrphanedActiveStack` — is covered regardless of caller.
Enable with `RUNDOWN_LOG_LEVEL=debug`; the logger stamps pid.

This is deliberately a debug signal, not a durable subsystem: the forensic
instrumentation that root-caused #536 (pid/ppid/argv/call-site records in an
append-only file) was scaffolding, removed once the writer was identified.
Durable, domain-level attribution of mutations is the province of the claim-id
and caller-evidence model (see the delegation-lifecycle roadmap's explicit
targeting work) — identity is named by the caller, not reconstructed from
process metadata. If an unattributed-writer class of bug ever reappears,
re-instrument from git history rather than re-deriving.

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
