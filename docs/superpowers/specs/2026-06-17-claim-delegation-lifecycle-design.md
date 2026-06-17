# Claim Delegation Lifecycle Design

Date: 2026-06-17

## Purpose

This document defines a conceptual architecture model for Rundown delegation, claims, actor context, and collection. It is intended to guide future implementation work and to reframe the current claim-closure barrier discussion around consistent domain language.

The design is not an immediate implementation plan. It describes the target model first, then notes migration slices that can move the current code toward that model incrementally.

## Goals

- Use consistent language for delegation, claims, delegated runs, delegation outcomes, and collection.
- Keep the existing `RESULT` / `HANDLER` / `ACTION` step semantics clear by avoiding overloaded use of the word "result" for delegation.
- Make `rd collect` the explicit orchestration mechanism for consuming delegated work.
- Require actor context for role-specific workflow mutation.
- Move lifecycle, targeting, and collection policy into core so CLI, MCP, and plugin front ends do not reimplement domain rules.
- Treat the existing barrier/resume wording as transitional, not as the target model.

## Non-Goals

- This design does not introduce adversarial security between local processes. Rundown remains an isolation-against-accident system.
- This design does not require immediate persisted-state migration.
- This design does not require all current CLI compatibility behavior to change at once.
- This design does not rename internal structural fields such as `parentRunId` and `childRunId` unless a later implementation plan chooses to do so.

## Terminology

Use these terms in user-facing docs and conceptual architecture:

| Term | Meaning |
| --- | --- |
| Delegation | A work slot issued by a delegating run. |
| Claim | A binding from a delegated agent/context to a delegated run. |
| Delegating run | The run that issued the delegation. |
| Delegated run | The run controlled through a claim. |
| Step result | Existing spec term: `pass` or `fail` produced by a step or substep. |
| Run terminal state | `completed` or `stopped` lifecycle of a runbook. |
| Delegation outcome | `pass` or `fail` projection from a delegated run terminal state into the delegating run. |
| Collection | Orchestrator action that applies delegation outcomes to the delegating run. |
| Collection pending | A delegation outcome exists but has not been collected. |
| Closed | The delegation attempt is operationally finished. A retained tombstone may still exist for idempotent command behavior. |
| Cancelled | The delegation attempt was intentionally cancelled. |
| Superseded | The delegation attempt was replaced by a retry attempt. |
| Stashed | The claimed delegated run is parked. This is a session-targeting state, not closure. |
| Pruned | Persisted state was deleted. This is storage cleanup, not a runtime lifecycle state. |

Avoid these terms in the target model:

- handoff
- resume
- acknowledgement
- generic result when referring to a delegation outcome
- parent/child in user-facing docs

Internal structural names such as `parentRunId` and `childRunId` may remain when they describe graph linkage. Conceptual and user-facing language should prefer `delegating run` and `delegated run`.

## Lifecycle Model

The primary lifecycle is:

```text
delegation_issued
  -> claim_active
  -> delegation_outcome_reported
  -> delegation_collection_pending
  -> collecting
  -> delegation_collected
  -> closed
```

Side paths:

```text
delegation_issued -> cancelled -> closed
claim_active -> stashed -> claim_active
claim_active -> cancelled -> closed
delegation_collection_pending -> superseded -> closed
closed -> pruned
```

### Delegation Issued

A delegating run has created a work slot and token. No delegated agent has claimed it yet.

Core facts:

- The delegating run records the token hash and delegation coordinates.
- A claim id may not exist yet.
- The delegation is claimable unless cancelled or superseded.

Allowed operations:

- A delegated agent may claim with the raw token.
- An orchestrator may cancel or retry the delegation.

### Claim Active

A delegated agent has claimed the token. A claim id now binds the delegated context to a delegated run.

Core facts:

- The claim maps to a delegated run id.
- The delegated run carries delegation linkage back to the delegating run.
- The delegated run is not pushed onto the default stack.

Allowed operations:

- The delegated context may inspect and mutate its own delegated run.
- The orchestrator may inspect delegation state and cancel or retry according to policy.
- Bare default-stack mutation must not silently target the delegated run.

### Delegation Outcome Reported

The delegated run reached a terminal state and core derived a delegation outcome:

```text
completed -> pass
stopped   -> fail
```

This state records the outcome for the delegating run but does not apply it to the delegating run's state machine.

The delegated agent's responsibility ends here:

```text
do claimed work
report delegation outcome
stop
```

### Delegation Collection Pending

A delegation outcome exists, but the delegating run has not collected it.

Policy:

- Bare mutating commands that would advance the delegating run are refused.
- The delegated context cannot collect.
- Unknown context cannot collect in the strict conceptual model.
- Orchestrator context can run `rd collect`.

The target error for unsafe bare mutation is:

```text
DELEGATION_COLLECTION_PENDING
```

### Collecting

Core applies one or more delegation outcomes to the delegating run.

Core checks:

- The caller has orchestrator context.
- The target is a delegating run, not a delegated run.
- Required delegation outcomes for the aggregation scope are present.
- No active claimed work still blocks collection for that scope.

Core then applies aggregation semantics such as `PASS ALL`, `PASS ANY`, `FAIL ALL`, `FAIL ANY`, and `DEFER`.

### Delegation Collected

The delegation outcome has been consumed into the delegating run's state machine. The delegating run may advance, stop, complete, or remain active according to normal state-machine semantics.

### Closed

The delegation attempt is operationally finished.

Closed does not necessarily mean deleted. A terminal claim tombstone may remain so repeated claim-targeted commands can confirm a matching terminal outcome or reject a conflicting one.

## Actor Context

Actor context is required for role-specific workflow mutation.

Conceptual shape:

```typescript
type ActorContext =
  | { kind: 'orchestrator'; runId: RunId }
  | { kind: 'delegated'; claimId: ClaimId; tokenHash: DelegationTokenHash }
  | { kind: 'unknown' };
```

`unknown` means Rundown has workspace state but no reliable caller role. `cwd + session.json` is not actor identity.

Examples of unknown context:

- Human shell without actor context.
- Generic script.
- MCP call without caller metadata.
- CI job.
- Agent shell after plugin/session context is lost.
- Any local process with only the workspace path.

Strict policy:

```text
unknown may inspect
unknown may not perform role-specific workflow mutation
```

Compatibility layers may temporarily relax this for direct CLI usage, but that is a compatibility concession, not the conceptual model.

## Command Policy

Core policy should derive command outcomes from:

- actor context
- command intent
- target selector
- delegation lifecycle state

Command intent categories:

```text
inspect
delegated-run mutation
delegating-run advance
delegation issuance
delegation collection
delegation cancellation
storage cleanup
```

Role-specific mutations:

| Actor context | Allowed role-specific mutations |
| --- | --- |
| Orchestrator | Issue delegation, retry delegation, cancel delegation, collect delegation outcomes, advance the delegating run when delegation state permits it. |
| Delegated | Mutate the claimed delegated run, report a delegation outcome, stash/pop the claimed delegated run. |
| Unknown | Inspect only in the strict model. |

Specific command policy:

```text
rd collect in orchestrator context:
  allowed when the target is a delegating run

rd collect in delegated context:
  COLLECT_REQUIRES_ORCHESTRATOR

rd collect in unknown context:
  ACTOR_CONTEXT_REQUIRED

rd collect --claim-id:
  invalid; collection is not claim-targeted

bare rd pass/fail/delegate while delegation_collection_pending:
  DELEGATION_COLLECTION_PENDING

delegated context bare rd pass/fail:
  may target the actor's own claim only if contextual targeting is deliberately adopted;
  otherwise require explicit --claim-id, but never fall through to the delegating run
```

Suggested typed outcomes:

```typescript
type CommandPolicyOutcome =
  | { kind: 'allowed'; target: ResolvedTarget }
  | { kind: 'actor_context_required' }
  | { kind: 'collect_requires_orchestrator' }
  | { kind: 'target_is_delegated_run' }
  | { kind: 'delegation_collection_pending' }
  | { kind: 'open_claims' }
  | { kind: 'stale_claim' }
  | { kind: 'terminal_claim_confirmed' }
  | { kind: 'terminal_claim_conflict' };
```

## Collection Model

The target model splits two operations:

```text
report delegation outcome
collect delegation outcome
```

### Reporting

Reporting is delegated-context work. It happens when the delegated run reaches a terminal state.

Input:

```text
claim id
delegated run terminal state
```

Core derives and records a delegation outcome against the delegating run's delegated substep.

Reporting does not drain or apply the outcome to the delegating run's state machine.

### Collection

Collection is orchestrator-context work. It applies reported delegation outcomes to the delegating run.

Input:

```text
orchestrator context
delegating run target
optional step/frame/index scope
```

Collection returns typed outcomes:

```text
collected
blocked_open_claims
blocked_missing_outcomes
already_collected
not_delegatable
requires_orchestrator_context
target_is_delegated_run
failed
```

Possible error names:

```text
DELEGATION_COLLECTION_PENDING
COLLECT_REQUIRES_ORCHESTRATOR
ACTOR_CONTEXT_REQUIRED
COLLECT_TARGET_NOT_DELEGATING_RUN
COLLECT_OUTCOMES_MISSING
```

`COLLECT_ALREADY_APPLIED` can be a non-error status if idempotent no-op behavior is preferred.

## Core And Frontend Boundary

The boundary should be:

```text
frontends parse and render
core decides lifecycle, targeting, and collection policy
```

Front ends may provide:

- actor context
- command intent
- flags and options
- input values
- output renderer

Front ends should not decide:

- whether a claim may report an outcome
- whether a delegation is collection pending
- whether collection is allowed
- whether a bare command is safe
- whether a delegated run can issue or collect delegation
- whether a terminal claim is idempotent or conflicting

Core should expose operations shaped around domain intents:

```typescript
claimDelegation(token, actorContext)
reportDelegationOutcome(claimId, outcome, actorContext)
resolveCommandIntent(intent, actorContext)
collectDelegationOutcomes(target, actorContext)
cancelDelegation(tokenOrDelegationId, actorContext)
retryDelegation(scope, actorContext)
stashClaim(claimId, actorContext)
popClaim(claimId, actorContext)
```

## Compatibility Notes

Current Rundown behavior differs from this strict conceptual model in several ways:

- `handleParentCompletion()` currently records a delegated-run completion and immediately drains/applies it to the delegating run.
- `rd collect` is not currently the only continuation mechanism.
- `rd collect --claim-id` is currently accepted.
- Bare CLI commands generally operate in unknown context and target the default stack.
- Plugin actor identity exists in plugin session metadata, but it is not a core command identity boundary.
- MCP is currently a CLI facade without actor context.

Implementation can preserve compatibility temporarily, but the domain rule should remain:

```text
No actor context, no role-specific workflow mutation.
Delegated agents report outcomes.
Orchestrators collect outcomes.
```

## Migration Strategy

### Slice 1: Rename Transitional Model Language

Stop adding new `handoff` and `resume` language.

Transitional names:

```text
ClaimHandoff -> DelegationCollectionPending or ClaimClosureBarrier
CLAIM_HANDOFF_PENDING -> DELEGATION_COLLECTION_PENDING or CLAIM_CLOSURE_PENDING
--resume -> remove from the model; use collect-oriented guidance
```

Preferred direction:

```text
DelegationCollectionPending
DELEGATION_COLLECTION_PENDING
```

Suggested message:

```text
A delegated claim has reported an outcome that must be collected by the orchestrator.
If you are the delegated agent, stop here. If you are the orchestrator, run rd collect.
```

### Slice 2: Core Command Policy

Move command policy to core as typed intent policy.

First targets:

- `collect` is orchestrator-only.
- `collect --claim-id` is rejected.
- `collect` targeting a delegated run is rejected.
- bare `pass` / `fail` / `delegate` are refused while delegation collection is pending.

### Slice 3: Split Report From Collect

Change claim closure from:

```text
close delegated run
record delegated-run completion
drain/apply delegating run
```

to:

```text
close delegated run
record delegation outcome
mark collection pending
```

Then:

```text
rd collect
  drains/applies delegation outcomes
```

This is the large behavior change and should have explicit scenario coverage.

### Slice 4: Actor Context Wiring

Introduce explicit actor context into CLI, plugin, and MCP.

Potential sources:

- plugin mapping from `agent_id` / `session_id` to token hash and claim id
- CLI environment or flag injected by the plugin
- MCP caller metadata where available
- explicit claim id for compatibility paths, if policy allows it

Core receives actor context explicitly and never infers it from `cwd`.

### Slice 5: Persisted Model Cleanup

Only after behavior is stable:

- make delegation outcome and collection pending explicit or consistently derived
- drop transitional barrier fields
- clean docs and schema names
- remove compatibility shims

Because persisted runbook state is not migrated, cleanup should happen before release boundaries or with explicit rejection of incompatible active state.

## Test Strategy

Core model tests:

- delegation lifecycle transition table
- actor context policy table
- collection pending derivation
- collect requires orchestrator
- unknown context cannot collect
- delegated context cannot collect

Integration and scenario tests:

- delegated agent reports outcome and stops
- orchestrator collects and advances
- bare command while collection pending is refused
- `collect --claim-id` is rejected
- delegated context collect is rejected
- unknown context collect is rejected in strict mode
- retry supersedes pending collection
- `abort --force` records a fail delegation outcome and requires collection

## Open Questions

- Should delegated context eventually allow contextual targeting for bare `rd pass` / `rd fail`, or should explicit `--claim-id` remain mandatory?
- Should closed terminal claim tombstones remain visible through `status --claim-id`, and for how long before prune?
- Should unknown direct CLI ever be treated as orchestrator by default, or only behind an explicit compatibility flag/config?
- Should collection pending be persisted explicitly, or derived from recorded delegation outcomes and delegating run cursor state?
- What exact actor context can MCP supply, and does it need a different trust model from the Claude Code plugin?
