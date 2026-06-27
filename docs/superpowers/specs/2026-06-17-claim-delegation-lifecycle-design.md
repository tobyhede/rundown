# Claim Delegation Lifecycle Design

Date: 2026-06-17

## Purpose

This document defines a conceptual architecture model for Rundown delegation, claims, actor context, and collection. It is intended to guide future implementation work and to reframe the current claim-closure barrier discussion around consistent domain language.

The design is not an immediate implementation plan. It describes the target
model first, then gives migration principles and a canonical plan breakdown
that can move the current code toward that model incrementally.

## Goals

- Use consistent language for delegation, claims, delegated runs, delegation outcomes, and collection.
- Keep the existing `RESULT` / `HANDLER` / `ACTION` step semantics clear by avoiding overloaded use of the word "result" for delegation.
- Make `rd collect` the explicit, target-relative orchestration mechanism for
  consuming delegated work.
- Require actor context for role-specific workflow mutation.
- Move lifecycle, targeting, and collection policy into core so CLI, MCP, and plugin front ends do not reimplement domain rules.
- Treat the existing barrier/resume wording as transitional, not as the target model.

## Non-Goals

- This design does not introduce adversarial security between local processes. Rundown remains an isolation-against-accident system.
- This design does not require immediate persisted-state migration.
- This design does not require all current CLI compatibility behavior to change at once.
- This design does not rename internal structural fields such as `parentRunId` and `childRunId` unless a later implementation plan chooses to do so.

## Scope Decision: N-Level Delegation Is Won't-Build (2026-06-20)

> **This supersedes the N-level passages below.** Several sections of this
> document (Lifecycle Model "middle node", Actor Context dual-role rules,
> Collection Model "N-level chains", Compatibility Notes on `createDelegation()`,
> and Plan 5's N-level coverage) describe a target model where a *delegated* run
> can itself *delegate*, forming chains more than one delegating level deep. **That
> capability will not be built.** Treat every "N-level" / "middle claim
> controller" / "relax the single-level invariant" passage as historical design
> exploration, not a requirement.

Rationale:

- **The runtime forbids it.** A Claude Code subagent cannot spawn subagents.
  Delegation's value over `rd run` is a *fresh isolated agent context*; recursing
  that at depth is exactly the unavailable operation. The substrate caps useful
  delegation at one level.
- **`RD-819` (`DELEGATION_NESTED_FORBIDDEN`) correctly mirrors that limit and
  stays.** `createDelegation()` keeps rejecting issuance from a run whose
  `parentLinkage.kind === 'delegation'`. The Compatibility-Notes intention to
  "intentionally change that behavior for N-level chains" is withdrawn.
- **Shallow-and-wide covers real work.** Bounded fan-out, map-reduce trees, and
  recursive decomposition are served by FOR-loop fan-out at one delegating level,
  by a single orchestrator dispatching staged waves of leaf workers, and by
  `rd run` for in-context composition. None require a delegated run to delegate.
- **The complexity it would add is unjustified.** Target-relative roles, the
  dual-hat middle node, and mid-chain collection exist *primarily* to serve
  N-level. With N-level removed, single-level delegation needs only: report on
  close, collect explicitly, one delegating level.

Consequence for the model: **collection is single-level because there is only
ever one delegating level.** Report-then-collect (the worker reports its outcome
on close; the orchestrator applies it with an explicit `rd collect`) is justified
on its own at N=1 — it separates worker-stop from orchestrator-advance and fixes
the `FAIL ANY STOP` aggregation-timing race — and does not depend on chains.

## Issuance Idempotency: Targeted Delegate Echoes an Auto-Issued Frontier (2026-06-27)

> **This finishes `delegation issuance` as a first-class command intent and
> clarifies the issuance passages below.** Bare `rd delegate` is idempotent on an
> auto-issued frontier (it echoes the existing token instead of throwing), but
> the *targeted* forms — `rd delegate --step <id>` and
> `rd delegate <runbook> --step <id>` — are not: they bypass issuance resolution
> and throw `RD-804` (`DELEGATION_ALREADY_EXISTS`). That asymmetry is a defect
> ([#468](https://github.com/tobyhede/rundown/issues/468)): a `DELEGATE` step
> auto-issues a token on entry, so the agent's first `rd delegate --step 1.1`
> lands on an already-issued frontier and is rejected. **Targeted issuance MUST
> resolve through the same path as bare issuance and echo the frontier token.**
> The current internal behavior contract is mirrored in
> `docs/internal/delegation-lifecycle.md` so implementers do not have to treat
> this historical design document as the only normative source.

This section is normative for [#468](https://github.com/tobyhede/rundown/issues/468)
even where older lifecycle-design material below is historical.

Rationale:

- **Issuance resolution belongs to core, once, for every invocation shape.** The
  intent model (this document, "delegation issuance") routes all issuance through
  the target-relative resolver. The idempotent-vs-fresh decision is runbook logic,
  not a per-form CLI branch. Today it lives in a purpose-built sibling resolver
  (`DelegateTargetResolution`: `issuable | already-issued | none`) that **only the
  bare path consults**; the `--step` forms reach `createDelegation()` directly and
  the runbook-confirmation form reimplements a partial check inline. Three
  mechanisms for one question is the seam that produced #468.
- **Auto-issue-on-entry is what creates the already-issued state.** A `DELEGATE`
  step issues tokens for its delegated substeps on entry, before any `rd delegate`
  runs. Echoing that token is the only coherent answer to "delegate this slot" when
  the slot is already issued and in flight; throwing makes the documented agent
  flow (`/rundown:planning` step 1) unusable.
- **`targeted: true` is already the seam.** Report-then-collect minted the
  `targeted` discriminant on the issuance intent and core deliberately bypasses
  the `delegation_collection_pending` gate for targeted issuance. The same
  discriminant is the hook for routing targeted issuance through policy +
  resolution uniformly; the type exists, the `--step` path just does not cross it.

Resolution rule:

```text
rd delegate            (bare)              -> resolve issuance; issue or echo frontier token
rd delegate --step S                       -> resolve issuance SCOPED TO S; issue or echo frontier token
rd delegate <runbook> --step S             -> resolve issuance SCOPED TO S:
                                                same runbook as in-flight  -> echo frontier token
                                                different runbook           -> RD-804 (genuine conflict)
rd delegate <runbook>  (no step)           -> resolve issuance for first pending substep; issue or echo
```

- **Echo shape is uniform.** An `already-issued` resolution emits the bare path's
  existing JSON (`{ kind: 'delegate', action: 'already-delegated', step, runbook,
  token, parent_run_id }`) regardless of invocation form, so every shape returns
  the same answer for the same state.
- **`RD-804` is preserved only as a genuine conflict** — an explicit `<runbook>`
  arg that names a *different* runbook than the in-flight delegation on that scope.
  Re-issuing a fresh token over an in-flight one stays the job of `--retry`, not of
  a repeated `rd delegate`.
- **`RD-813` (`DELEGATION_NO_DELEGATABLE_SUBSTEP`) and `RD-814`
  (substep-missing-runbook) are unchanged** — `none` resolution and missing-runbook
  remain hard errors. `RD-819` (`DELEGATION_NESTED_FORBIDDEN`) is unchanged.
- **Resolution is frame-scoped.** For a `FOR` step, scoped resolution keys on the
  iteration frame (`--index` / three-level id), matching the writer/reader
  frame-key agreement used by the rest of the delegation model.

Consequence for the model: **issuance resolution is single-sourced.** Extend the
core resolver to accept an optional target scope (step / frame / index) and route
*all* `rd delegate` shapes through it; remove the CLI's per-branch issuance logic
(`findPendingDelegationForTarget` inline check and the bare-`--step` fall-through to
`createDelegation`). The `DelegationPolicyOutcome` union is unchanged — issuance
*resolution* stays in its purpose-built sibling type per the union's own scoping
rule; policy continues to own only the *gate* decisions (`actor_context_required`,
the targeted bypass of `delegation_collection_pending`).

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
| Outcome reported | Per-claim fact that a delegated run reached a terminal state and produced a delegation outcome. |
| Collection | Target-relative orchestrator action that applies delegation outcomes to the delegating run. |
| Collection pending | Derived delegating aggregation-scope state: recorded unconsumed delegation outcomes exist for a still-valid open delegating frame/scope of a run. |
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

The primary per-claim lifecycle is:

```text
delegation_issued
  -> claim_active
  -> closed
```

Side paths:

```text
delegation_issued -> cancelled -> closed
claim_active -> stashed -> claim_active
claim_active -> cancelled -> closed
claim_active -> superseded -> closed
closed -> pruned
```

`outcome_reported` is a fact recorded on a claim before it closes. It is not a
sequential lifecycle state after `claim_active`.

`collection_pending` is not a per-claim lifecycle state. It is derived for a
delegating run from recorded, unconsumed delegation outcomes plus the delegating
run's still-valid open delegating frame/scope records. A delegating run can be
collection pending even though the reporting claim is already closed and even
when its current cursor has moved away from the frame that originally issued
the delegation.

### Delegation Issued

A delegating run has created a work slot and token. No delegated agent has claimed it yet.

Core facts:

- The delegating run records the token hash and delegation coordinates.
- A claim id may not exist yet.
- The delegation is claimable unless cancelled or superseded.

Allowed operations:

- A delegated agent may claim with the raw token.
- An actor that controls the delegating run may cancel or retry the delegation.

### Claim Active

A delegated agent has claimed the token. A claim id now binds the claim
controller to a delegated run.

Core facts:

- The claim maps to a delegated run id.
- The delegated run carries delegation linkage back to the delegating run.
- The delegated run is not pushed onto the default stack.

Allowed operations:

- The claim controller may inspect and mutate its own delegated run.
- An actor that controls the delegating run may inspect delegation state and
  cancel or retry according to policy.
- Bare default-stack mutation must not silently target the delegated run.

### Outcome Reported Fact

The delegated run reached a terminal state and core derived a delegation outcome:

```text
completed -> pass
stopped   -> fail
```

This fact records the outcome for the delegating run but does not apply it to the delegating run's state machine.

The delegated agent's responsibility ends here:

```text
do claimed work
close the claimed run through a terminal command
stop
```

Ordinary cancellation is different from a failed delegated run. Cancelling an
issued or active delegation closes that attempt without synthesizing a fail
outcome. A force abort of an active claimed delegated run is the explicit
exception: it stops/deletes the in-flight delegated run, records a `fail`
delegation outcome with cancellation ignored for that recording operation, and
leaves the delegating scope collection pending.

### Collection Pending

At least one delegation outcome exists for a still-valid open delegating
aggregation scope of the run, but that scope has not collected it.

Scope rule:

- Evaluate `collection_pending` per delegating aggregation scope.
- A bare advance of a run is blocked when any unconsumed outcome exists in any
  still-valid open delegating frame/scope for that run, not only the current
  cursor. This prevents a later bare command from advancing past stale
  uncollected FOR-frame outcomes.
- A targeted command may address a specific scope only when core policy resolves
  that target explicitly and the command is valid for that target.

Policy:

- Bare mutating commands that would advance the delegating run are refused.
- Collection is allowed only when the caller is the effective orchestrator for
  the target delegating scope.
- A delegated actor cannot collect into an ancestor's run merely because it
  controls a claimed descendant.
- The same delegated actor can collect into the claimed run it controls when
  that run issued delegations of its own.
- Unknown context cannot collect in the strict conceptual model.

The target error for unsafe bare mutation is:

```text
DELEGATION_COLLECTION_PENDING
```

### Collecting

Core applies one or more delegation outcomes to the delegating run.

Core checks:

- The caller has effective orchestrator role for the target delegating scope.
- The target is an explicit delegating run/scope.
- Required delegation outcomes for the aggregation scope are present.
- No active claimed work still blocks collection for that scope.

Core then applies aggregation semantics such as `PASS ALL`, `PASS ANY`, `FAIL ALL`, `FAIL ANY`, and `DEFER`.

Collection is single-level. Collecting a delegating run may advance that run to
a terminal state. If that run is itself delegated, core reports a new outcome
to its own delegating run, but it does not recursively collect that ancestor.
Each delegating level requires an explicit `rd collect` by an actor that is the
effective orchestrator for that level. This replaces the current recursive
drain/apply behavior in `handleParentCompletion()`.

### Delegation Collected

The delegation outcome has been consumed into the delegating run's state machine. The delegating run may advance, stop, complete, or remain active according to normal state-machine semantics.

### Closed

The delegation attempt is operationally finished.

Closed does not necessarily mean deleted. A terminal claim tombstone may remain so repeated claim-targeted commands can confirm a matching terminal outcome or reject a conflicting one.

## Actor Context

Actor context is required for role-specific workflow mutation, but it is not
itself the role decision. Role is relative to the target run/scope.

Conceptual shape:

```typescript
type ActorContext =
  | { kind: 'trusted_run_controller'; runId: RunId; source: 'direct-cli' | 'plugin' | 'mcp' }
  | {
      kind: 'claim_controller';
      claimId: ClaimId;
      tokenHash: DelegationTokenHash;
      controlledRunId: RunId;
    }
  | { kind: 'unknown' };
```

`ActorContext` records evidence about the caller: which run it controls, which
claim it owns, or that no trusted evidence is available. It does not say
"orchestrator" or "delegated" as an absolute capability.

Policy derives an effective target-relative role from `(intent, actorContext,
target)`:

```typescript
type EffectiveRole =
  | 'orchestrator_for_target'
  | 'delegated_relative_to_target'
  | 'unknown_for_target';
```

Rules:

- A caller that controls the target run is the effective orchestrator for
  mutations and collections into that target run.
- A claim controller is delegated relative to the run that issued its claim, but
  it is the effective orchestrator of delegations issued by the claimed run it
  controls.
- ~~A middle node in an N-level chain therefore has two relationships at once: it
  reports upward to its own delegating run, and it collects downward from
  delegations that its controlled run issued.~~ **Withdrawn — no middle node
  exists under single-level delegation (see "Scope Decision: N-Level Delegation
  Is Won't-Build"). A claim controller has exactly one relationship: it reports
  upward to its delegating run.**
- A claim controller cannot collect into its ancestor's run merely by being a
  delegated descendant of that run.
- `unknown` means Rundown has workspace state but no reliable caller evidence.
  `cwd + session.json` is not actor identity.

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

Direct CLI compatibility lane:

- Strict core policy treats `unknown` as inspect-only.
- The direct local CLI may explicitly map a bare workspace invocation to a
  trusted run-controller actor context by default for compatibility.
- That mapping is a frontend adapter decision. Core still receives an explicit
  actor context, a target, and applies the same typed policy.
- The collection-pending guard still blocks bare `pass`, `fail`, and `delegate`
  even in direct CLI compatibility mode. The user must run `rd collect`.
- Plugin and MCP callers do not inherit direct CLI compatibility unless they
  explicitly provide equivalent trusted run-controller metadata.

## Command Policy

Core policy should derive command outcomes from:

- actor context
- command intent
- target selector
- delegation lifecycle state

The policy question is target-relative:

```typescript
resolveCommandIntent(intent, actorContext, target): DelegationPolicyOutcome
```

Existing claim-id targeting mechanics already point in this direction:
`CommandTargetResolution` distinguishes default, claim, terminal-claim, stale
claim, and no-target outcomes, while `ClaimRecord` stores `claimId`,
`childRunId`, `parentRunId`, `parentStepId`, `parentFrameKey`, and
`parentEntry`. The target model should keep that explicit actor/target
relationship rather than infer role from the workspace alone.

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

| Effective relationship to target | Allowed role-specific mutations |
| --- | --- |
| Orchestrator for target | Issue delegation from the target run, retry or cancel delegations issued by the target run, collect delegation outcomes into the target run, advance the target run when delegation state permits it. |
| Delegated relative to target | Report the controlled run's terminal outcome to the target run when the target issued the claim; inspect only otherwise. |
| Unknown for target | Inspect only in the strict model. |

Specific command policy:

```text
rd collect when actor is orchestrator for target:
  allowed when the target is a delegating run/scope

rd collect when actor is delegated relative to target:
  COLLECT_REQUIRES_ORCHESTRATOR

rd collect when actor is unknown for target:
  ACTOR_CONTEXT_REQUIRED

rd collect --claim-id:
  valid only as an explicit target selector for the resolved claimed run;
  policy still requires the actor to be orchestrator for that resolved target

bare rd pass/fail/delegate while delegation_collection_pending:
  DELEGATION_COLLECTION_PENDING

claim-controller bare rd pass/fail:
  may target the actor's controlled claimed run only if contextual targeting is
  deliberately adopted; otherwise require explicit --claim-id, but never fall
  through to the delegating ancestor run

middle claim-controller rd collect:
  WITHDRAWN — no middle node exists under single-level delegation (see "Scope
  Decision: N-Level Delegation Is Won't-Build"). Single-level collect policy is
  covered by "rd collect --claim-id" above.
```

Core owns one typed policy outcome union for lifecycle, targeting, and collection
decisions. CLI, MCP, and plugin frontends map this union to command-specific
messages, error codes, and exit codes.

```typescript
type DelegationPolicyOutcome =
  | { kind: 'allowed'; target: ResolvedTarget }
  | { kind: 'actor_context_required' }
  | { kind: 'collect_requires_orchestrator' }
  | { kind: 'target_not_delegating_scope' }
  | { kind: 'delegation_collection_pending' }
  | { kind: 'open_claims' }
  | { kind: 'missing_outcomes' }
  | { kind: 'already_collected' }
  | { kind: 'not_delegatable' }
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

Reporting is core work triggered by delegated terminal close. There is no
separate `rd report` command.

Reporting happens when the delegated run reaches a terminal state through
`complete`, `stop`, or a terminal `pass` / `fail` path. Those commands invoke
core `reportDelegationOutcome` as part of closing the claimed run. `abort
--force` is the explicit exception that can report a `fail` delegation outcome
while tearing down an active claimed run.

Input:

```text
claim id
delegated run terminal state
```

Core derives and records a delegation outcome against the delegating run's delegated substep.

Reporting does not drain or apply the outcome to the delegating run's state machine.
Reporting closes the claim operationally, except for retained terminal
tombstones used for idempotent command behavior.

### Collection

Collection is target-relative orchestrator work. It applies reported delegation
outcomes to the target delegating run/scope.

Input:

```text
actor context
delegating run target
optional step/frame/index scope
```

Collection returns the core-owned typed policy outcome union, not a
collection-specific result union:

```text
DelegationPolicyOutcome
```

Collection is single-level by design. It consumes outcomes for one delegating
scope and applies them to that run's state machine. If that application causes
the run to complete or stop and that run was itself delegated, reporting to the
next ancestor is allowed, but collection of that ancestor remains explicit.

~~For N-level chains, a middle claim controller can collect outcomes reported by
delegations issued by its own controlled run, including deeper delegated
descendants that report into that controlled run. After that controlled run
reaches a terminal state, it reports one outcome upward. The ancestor still
needs its own explicit collection by an actor that is effective orchestrator for
the ancestor target.~~ **Withdrawn — N-level is won't-build (see "Scope
Decision: N-Level Delegation Is Won't-Build"). There is one delegating level: a
delegated worker reports its outcome on close, and the single orchestrator
applies it with an explicit `rd collect`.**

Frontend mappings may render selected policy outcomes with command-specific
codes such as:

```text
DELEGATION_COLLECTION_PENDING
COLLECT_REQUIRES_ORCHESTRATOR
ACTOR_CONTEXT_REQUIRED
COLLECT_TARGET_NOT_DELEGATING_RUN
COLLECT_OUTCOMES_MISSING
```

`COLLECT_ALREADY_APPLIED` can be a non-error frontend code for the
`already_collected` outcome if idempotent no-op behavior is preferred.

## Inline Composition Force-Terminal

Inline composition (`parentLinkage.kind === 'inline'`) is not delegation. An
inline child runs in the same default-stack lineage as its parent and flows its
result back synchronously; it never reports a delegation outcome and is never
collection pending. Because of that, the lifecycle/collection model above does
not govern how an inline chain is force-terminated. This section records the
intent so a future change to delegation/collection policy does not silently break
inline force-terminal behavior.

Two command meanings must not be conflated:

- **Handler-derived `COMPLETE` / `STOP` actions** — the `ACTION` a step's handler
  resolves to (see `CLAUDE.md` Conceptual Model). These drive normal
  state-machine progression of a single run.
- **CLI `rd complete` / `rd stop` force overrides** — an operator command that
  forces a workflow terminal regardless of the current step's handler.

The target model for the CLI force override:

- Bare `rd complete` / `rd stop` target the **outermost contiguous-inline
  ancestor** of the active run: climb `parentLinkage.kind === 'inline'`, and stop
  before any delegation boundary.
- Every still-running inline descendant in that active chain is forced to the same
  terminal lifecycle, descendant-to-root, so no `running` inline descendant
  remains under a terminal inline ancestor.
- The cascade does not cross a delegation boundary. If the resolved inline root is
  itself a delegated run, it reports its terminal outcome upward (report-only) and
  the delegating parent advances only on an explicit `rd collect` — i.e. the inline
  force-terminal cascade hands back to the report-then-collect model exactly at the
  delegation boundary.
- `rd complete --claim-id` / `rd stop --claim-id` are unchanged: they target the
  named delegated child directly and keep delegated report-only semantics. They do
  not use inline-root targeting.
- `rd pass` / `rd fail` are not force overrides. They remain unit-local: they
  close the active inline unit and drive normal inline parent progression. The
  collection-pending guard on bare `pass` / `fail` / `delegate` is unaffected.
- Bare `rd stop` is a failure terminal and exits non-zero. `rd stop --claim-id`
  keeps command-success exit behavior for delegated report-only close.

This is a distinct command intent that the taxonomy in
[Command Policy](#command-policy) does not otherwise name: a workflow-level
force-terminal of the inline ancestor. It is coherent with the single-level
collection model precisely because it stops at the delegation boundary and so
cannot create a second collection level.

Implemented by `resolveActiveInlineForceTerminalPlan` (core) and
`forceTerminalWorkflow` (CLI); see
`docs/superpowers/plans/2026-06-24-inline-force-terminal-composed-parent.md`.

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
claimDelegation(token, actorContext, target): DelegationPolicyOutcome
reportDelegationOutcome(claimId, outcome, actorContext, target): DelegationPolicyOutcome
resolveCommandIntent(intent, actorContext, target): DelegationPolicyOutcome
collectDelegationOutcomes(target, actorContext): DelegationPolicyOutcome
cancelDelegation(tokenOrDelegationId, actorContext, target): DelegationPolicyOutcome
retryDelegation(scope, actorContext, target): DelegationPolicyOutcome
stashClaim(claimId, actorContext, target): DelegationPolicyOutcome
popClaim(claimId, actorContext, target): DelegationPolicyOutcome
```

`target` should carry the resolved run/scope, not just a run id string. For
collection this includes the delegating run plus any step/frame/index scope
needed to choose the aggregation scope. For claim-id targeting this should be
the core `CommandTargetResolution`-style result so terminal, stale, and missing
claim behavior remains explicit.

## Compatibility Notes

Current Rundown behavior differs from this strict conceptual model in several ways:

- ~~`handleParentCompletion()` currently records a delegated-run completion and immediately drains/applies it to the delegating run.~~
  **Superseded — report-then-collect (Plan 5) landed.** `handleParentCompletion()`
  no longer exists; `propagateChildTerminal()` type-splits inline (synchronous
  drain/advance) from delegation (report-only, leaves collection pending). The
  delegating run advances only on an explicit `rd collect`.
- `createDelegation()` currently enforces a single-level delegation invariant by
  rejecting delegation from a run whose `parentLinkage.kind === 'delegation'`.
  ~~this target model intentionally changes that behavior for N-level chains.~~
  **Withdrawn — see "Scope Decision: N-Level Delegation Is Won't-Build". RD-819
  stays; the single-level invariant is permanent.**
- `rd collect` is not currently the only continuation mechanism.
- `rd collect --claim-id` is currently accepted.
- Bare CLI commands generally operate in unknown context and target the default stack.
- Plugin actor identity exists in plugin session metadata, but it is not a core command identity boundary.
- MCP is currently a CLI facade without actor context.
- `abort --force` currently records a fail completion for an in-flight delegated run
  with `ignoreCancellation: true`; the target model preserves that as the
  deliberate force-abort exception, but it records fail and leaves collection
  pending rather than resolving the delegating substep by itself.

Implementation can preserve compatibility temporarily, but the domain rule should remain:

```text
No actor context, no role-specific workflow mutation.
Delegated agents report outcomes upward.
Actors collect outcomes only when they are effective orchestrators for the
target delegating scope.
```

Direct local CLI compatibility may map bare workspace commands to
trusted run-controller context by default. That adapter does not change the
target-relative core policy, and it must not bypass the collection-pending guard
for bare `pass`, `fail`, or `delegate`.

## Migration Strategy

This section is only a migration overview. The canonical sequencing is the
Implementation Plan Breakdown below; do not maintain a second detailed roadmap
here.

Principles:

- Stop adding new `handoff` and `resume` language.
- Introduce explicit actor context and target resolution before enforcing
  target-relative role policy.
- Move command policy and collection decisions into core before changing
  terminal-close behavior.
- Split reporting from collection only after core has a typed collection
  operation and frontend adapters render `DelegationPolicyOutcome`.
- Keep direct local CLI compatibility explicit in frontend adapters; do not
  encode it as the domain model.
- Preserve the cancellation split: ordinary cancel closes without fail; `abort
  --force` records fail and leaves collection pending.
- Clean persisted fields last. Rundown does not migrate persisted runbook state
  between versions, so incompatible active state must be rejected rather than
  migrated.

The existing claim handoff barrier work is transitional and
superseded by this design direction. Do not extend the June 2026 handoff/resume
model as the long-term implementation. If any of that work is reused, rewrite
its domain surface around delegation outcomes, collection pending, and explicit
collection before implementation.

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
A delegated claim has reported an outcome that must be collected by an actor
that controls this target run. If this is your ancestor's run, stop here. If
this is a run you control, run rd collect.
```

## Implementation Plan Breakdown

This design should not be implemented as one monolithic plan. It crosses core
lifecycle, command policy, collection behavior, CLI compatibility, plugin
identity, MCP identity, documentation, and persisted model cleanup. Break the
work into small plans where each plan produces independently testable software.

> **Status (2026-06-24).** Plans 1–5 have landed: the core lifecycle/policy/
> collection spine and the report-then-collect behavior split are implemented and
> wired into the CLI. Plan 2 has no standalone plan file but is fully realized in
> code (`packages/core/src/runbook/actor-context.ts`). Plan 8 is largely
> satisfied incidentally (transitional `ClaimHandoff` / `CLAIM_HANDOFF_PENDING` /
> `--resume` names are gone) but was never run as a deliberate final pass. Plans 6
> (plugin actor context) and 7 (MCP actor context) are NOT STARTED — both
> frontends still capture caller metadata without constructing a core
> `ActorContext`. Per-plan "landed" notes appear on each plan below.

Recommended dependency chain:

```text
delegation lifecycle foundation
  -> actor-context foundation
  -> core command policy
  -> core collection operation
  -> report-then-collect behavior split
  -> frontend actor-context hardening
  -> persisted model cleanup
```

### Plan 1: Delegation Lifecycle Foundation — LANDED

Suggested file:

```text
docs/superpowers/plans/2026-06-17-delegation-lifecycle-foundation.md
```

Scope:

- Establish target terminology in code and docs where new names are needed.
- Register target error names such as `DELEGATION_COLLECTION_PENDING`.
- Add core read models for outcome-reported facts and derived collection-pending
  state.
- Avoid major behavior changes.

Likely areas:

- `packages/core/src/runbook/types.ts`
- `packages/core/src/runbook/claim-id.ts`
- `packages/core/src/output/zod-schemas.ts`
- core model tests under `packages/core/__tests__/runbook/`
- documentation that currently introduces new handoff/resume wording

### Plan 2: Actor Context Foundation — LANDED (no standalone plan file)

Suggested file:

```text
docs/superpowers/plans/2026-06-17-actor-context-foundation.md
```

Scope:

- Add core actor-context types and API plumbing.
- Add target-relative effective-role derivation from `(intent, actorContext,
  target)`.
- Add frontend adapters that pass explicit actor context into core.
- Preserve direct local CLI compatibility by mapping bare workspace invocations
  to trusted run-controller context in the CLI adapter.
- Keep plugin and MCP unknown unless they provide explicit trusted metadata.

Likely areas:

- new `packages/core/src/runbook/actor-context.ts`
- core service constructors and command entry points that need actor context
- CLI command setup and shared helpers
- plugin and MCP call boundaries where actor context can be supplied
- actor-context unit tests

### Plan 3: Core Command Policy — LANDED (intentional subset of the outcome union)

Suggested file:

```text
docs/superpowers/plans/2026-06-17-core-command-policy.md
```

Scope:

- Add a core-owned command policy API around actor context, command intent,
  target selector, and delegation lifecycle state.
- Shape the main API as
  `resolveCommandIntent(intent, actorContext, target): DelegationPolicyOutcome`.
- Return a single core-owned `DelegationPolicyOutcome` union.
- Treat `rd collect --claim-id` as an explicit target selector for the resolved
  claimed run; allow it only when the actor is effective orchestrator for that
  target and the target has a collectable delegating scope.
- Reject collection into ancestor runs when the actor is only delegated relative
  to that ancestor target.
- Refuse bare `pass`, `fail`, and `delegate` while delegation collection is
  pending.
- Keep direct-CLI compatibility explicit; do not silently encode it as the
  domain model.
- Preserve the cancellation split: ordinary cancel closes without fail; force
  abort of an active claimed delegated run records fail and leaves collection pending.

Likely areas:

- `packages/core/src/runbook/actor-context.ts`
- new `packages/core/src/runbook/command-policy.ts`
- `packages/core/src/runbook/command-target-resolver.ts`
- `packages/cli/src/helpers/transitions.ts`
- `packages/cli/src/commands/collect.ts`
- core command-policy table tests

### Plan 4: Core Collection Operation — LANDED

Suggested file:

```text
docs/superpowers/plans/2026-06-17-core-collection-operation.md
```

Scope:

- Move collection orchestration out of the CLI and into core.
- Expose a domain operation such as
  `collectDelegationOutcomes(target, actorContext): DelegationPolicyOutcome`.
- Make collection single-level; do not recursively collect ancestors.
- Allow a claim controller to collect outcomes for delegations issued by the
  controlled run, while still rejecting collection into its delegating ancestor.
- Keep the CLI responsible for parsing flags and rendering typed outcomes only.
- Preserve current behavior where possible until the report/collect split lands.

Likely areas:

- new `packages/core/src/runbook/collection-service.ts`
- `packages/core/src/runbook/completion-service.ts`
- `packages/cli/src/commands/collect.ts`
- collection-focused core tests
- CLI integration tests for rendering and exit codes

### Plan 5: Report Then Collect — LANDED

Suggested file:

```text
docs/superpowers/plans/2026-06-17-report-then-collect.md
```

Scope:

- Change delegated claim closure from immediate delegating-run drain/apply to:

```text
close delegated run
record delegation outcome
derive collection pending from recorded unconsumed outcomes in still-valid open
delegating aggregation scopes
stop
```

- Make `rd collect` the explicit operation that applies delegation outcomes to
  the delegating run.
- ~~Add N-level and mixed inline/delegation cascade coverage proving each
  delegating level requires explicit collection.~~ **Withdrawn — N-level is
  won't-build (see Scope Decision). Coverage is single-level only.**
- ~~Add mid-chain coverage where the middle claim controller collects outcomes
  reported by delegated runs issued by its controlled run, then reports one
  terminal outcome upward.~~ **Withdrawn — no middle node exists under the
  single-level model.**
- Add scenario coverage for the user-visible workflow change (single delegating
  level: worker reports on close, orchestrator collects explicitly).

This is the highest-risk behavior change. It should land only after the core
policy and core collection operation plans are in place.

Likely areas:

- `packages/cli/src/helpers/delegation-completion.ts`
- `packages/core/src/runbook/completion-service.ts`
- `packages/core/src/runbook/collection-service.ts`
- `packages/cli/src/commands/pass.ts`
- `packages/cli/src/commands/fail.ts`
- `packages/cli/src/commands/complete.ts`
- `packages/cli/src/commands/stop.ts`
- `packages/cli/src/commands/collect.ts`
- delegation workflow integration tests and scenario fixtures

### Plan 6: Claude Plugin Actor Context — NOT STARTED

Suggested file:

```text
docs/superpowers/plans/2026-06-17-plugin-actor-context.md
```

Scope:

- Map Claude Code `agent_id`, `session_id`, token hash metadata, and claim id
  metadata into core actor context.
- Replace plugin-only claim-controller guard behavior with core policy where
  possible.
- Keep plugin hooks responsible for extracting caller metadata and presenting
  guidance, not deciding lifecycle policy.

Likely areas:

- `packages/claude-code-plugin/src/workflow/hooks/delegation-dispatch.ts`
- `packages/claude-code-plugin/src/workflow/hooks/delegated-bash-guard.ts`
- `packages/claude-code-plugin/src/workflow/hooks/subagent-stop.ts`
- plugin session schemas and tests

### Plan 7: MCP Actor Context — NOT STARTED

Suggested file:

```text
docs/superpowers/plans/2026-06-17-mcp-actor-context.md
```

Scope:

- Define what actor context, if any, MCP can supply.
- Treat MCP unknown context as inspect-only unless it supplies explicit trusted
  run-controller or claim-controller metadata.
- Stop treating MCP as only a CLI facade for role-specific workflow mutation.

Likely areas:

- `packages/mcp/src/tools.ts`
- MCP tool schemas and command construction tests
- core policy integration tests for MCP-style callers

### Plan 8: Persisted Model Cleanup — PARTIAL (incidental; no deliberate pass)

Suggested file:

```text
docs/superpowers/plans/2026-06-17-delegation-model-cleanup.md
```

Scope:

- Remove transitional names and compatibility shims.
- Make delegation outcome explicit and collection-pending state consistently
  derived.
- Update schemas and docs to the final terminology.
- Reject incompatible active state rather than migrating it.

This must be last. Rundown does not migrate persisted runbook state between
versions, so cleanup should happen after behavior is stable and before any
release boundary that would otherwise need compatibility code.

## Test Strategy

Core model tests:

- delegation lifecycle transition table
- actor context plus target policy table
- effective role derivation for trusted run controllers, claim controllers, and
  unknown callers
- collection pending derivation per delegating aggregation scope
- bare advance is blocked when any unconsumed outcome exists in any still-valid
  open delegating frame/scope for the run
- collect requires effective orchestrator role for the target
- unknown context cannot collect
- claim controller cannot collect into its delegating ancestor run
- claim controller can collect into the controlled run when that run issued
  delegations
- direct local CLI compatibility maps to trusted run-controller context while
  still blocking bare `pass`, `fail`, and `delegate` when collection is pending
- ordinary cancel closes without a fail outcome
- force abort of an active claimed delegated run reports a fail outcome and leaves
  collection pending
- collection is single-level and does not recursively collect ancestors

Integration and scenario tests:

- delegated agent reports outcome and stops
- effective orchestrator collects and advances the target run
- ~~N-level delegated chains require explicit collect at each delegating level~~
  **Withdrawn — N-level is won't-build (see Scope Decision). Collection is
  single-level only.**
- ~~middle claim controller collects outcomes reported by delegated descendants
  of its controlled run, then reports one outcome upward~~
  **Withdrawn — no middle node exists under the single-level model.**
- mixed inline substep and delegated chains do not silently cascade collection
- bare command while collection pending is refused
- `collect --claim-id` targets the resolved claimed run and is allowed or
  rejected by target-relative policy
- claim controller collect into ancestor target is rejected
- claim controller collect into controlled-run target is allowed when that run
  has reported delegated outcomes
- unknown context collect is rejected in strict mode
- retry supersedes pending collection
- `abort --force` records a fail delegation outcome and leaves collection
  pending

## Open Questions

- Should claim-controller context eventually allow contextual targeting for bare
  `rd pass` / `rd fail`, or should explicit `--claim-id` remain mandatory? (For
  `rd complete` / `rd stop` this is now settled: bare force-terminates the inline
  ancestor, `--claim-id` keeps delegated-child scope. See "Inline Composition
  Force-Terminal". The question stands open for `rd pass` / `rd fail`, which
  remain unit-local.)
- Should closed terminal claim tombstones remain visible through `status --claim-id`, and for how long before prune?
- What exact trusted actor metadata can MCP supply for non-inspect operations?
