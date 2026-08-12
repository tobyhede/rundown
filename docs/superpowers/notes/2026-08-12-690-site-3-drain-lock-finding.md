# 690 site 3 — why the drain's CompletionLock cannot follow sites 1 and 2

**Tracks:** [#690](https://github.com/tobyhede/rundown/issues/690)
**Verified against:** `07d998dcb`, 2026-08-12.

**Amends** the site-3 recommendation in
[2026-08-12-690-domain-lock-deletion-handoff.md](../plans/2026-08-12-690-domain-lock-deletion-handoff.md)
(§ Phase 2, site 3), which proposed routing the CLI drain wrapper onto
`prepareResolvedCompletionDrain`. That route does not work as described. The
dated handoff is immutable; this note corrects it.

## What sites 1 and 2 did, and why it does not transfer

`recordManualCompletion` and `recordChildCompletion` each held a lock across
`load → classify → commit`. The fix was moving the classification inside the
`mutateState` build callback, so the decision derives from the version the CAS
commits onto. That works because the classification is a **pure function of one
captured state** — it can be replayed per attempt with no external effect.

The drain's per-apply decision is not pure. It runs the XState actor.

## The actual read/write shape, per apply

`drainResolvedCompletionsUnlocked` (`completion-service.ts:1434`) loops, and each
iteration performs **three independent reads and one blind write**:

| # | Operation | Where |
| --- | --- | --- |
| 1 | `lifecycleService.listResolvedCompletions` → `manager.load` | `completion-service.ts:1481` |
| 2 | `sendAndSync` → `manager.load` to hydrate the actor | `actor-service.ts:1711` |
| 3 | `buildConsumedCompletionPatch` → `manager.load` | `actor-service.ts:1471` |
| 4 | `manager.update(id, patch)` | `actor-service.ts:1169` |

Read 1 selects which completion to apply. Read 2 builds the actor the event is
sent to. Read 3 confirms the key is still present and derives its removal.
Write 4 commits a patch derived from all three.

**`manager.update` discards the CAS's captured state.** It is
`mutate(id, () => updates, …)` (`state.ts:662`) — the builder ignores `current`
and returns the precomputed patch. So the compare-and-swap prevents a lost
*version*, but not a stale *derivation*: on a retry it re-commits the same patch
built from the pre-CAS reads.

Two concurrent drains on one run therefore both select the same completion at
read 1, both see it present at read 3, and both commit. The `CompletionLock` is
what closes that window today. It is load-bearing, not vestigial.

## Why the handoff's recommendation does not apply

The proposed move was to route the CLI wrapper (`execution.ts:1190`) onto the
already-fenced `prepareResolvedCompletionDrain`. The wrapper cannot consume a
whole prepared pass: it calls the core drain with `maxApplied: 1` inside its own
`for (;;)` loop (`execution.ts:1210-1218`) and runs `observeAndOrchestrate`
between applies (`:1243`). That orchestration emits `STEP_TRANSITIONED`, applies
terminal session side effects, and returns a state that feeds the next iteration
(`:1265-1266`).

`prepareResolvedCompletionDrain` derives every apply against its own captured
state with no orchestration interleaved, so substituting it changes both the
event stream and the state each apply builds on. `collectDelegationOutcomes`
(`collection-service.ts:771`) can use it precisely because it commits an
aggregate and emits nothing per apply.

## The two real options

**A. Fold the apply into the commit.** Make the actor send re-runnable inside a
`build` callback: derive the consume patch from the captured state rather than a
third load, and replace `updateFromActor`'s blind `manager.update` with a
state-derived one. `prepareActorMutation` (`actor-service.ts:1193`) already
computes an actor transition without persisting, so the pieces exist. The
obstacle is that `sendAndSync` is shared with `EXECUTE_COMMAND`, which spawns
processes — a `build` callback that can re-run must not carry that path, so this
needs a separate committed seam for the apply event, not a change to
`sendAndSync` itself.

**B. Keep the lock at this site.** Document it as the one surviving domain lock,
with the partial-commit design as its stated reason, and close #690 with four of
six sites migrated plus the CLI sites.

Option A is the one consistent with the architecture (the state machine owns the
transition; the store owns atomicity). It is a redesign of the actor commit
seam, not a refactor, and it is larger than the remaining CLI sites combined.

## What this means for #690's acceptance

The acceptance item asking for "transaction ownership, rollback, contention, and
committed-before-observation coverage at the SQL workflow layer" collides with
the drain's documented per-completion commit — only the FIRST apply arms the
parent-advance guard (`completion-service.ts:1525`), because re-arming it on a
follow-on apply would let an unrelated child claiming mid-drain abort a pass
whose earlier applies already committed (`session-service.ts:1520-1533` states
the same rule from the guard's side). Making the drain atomic overturns that
decision and needs its own rationale. It must not happen as a side effect of
deleting a lock.
