---
'@rundown-org/core': minor
'@rundown-org/cli': minor
---

# Re-derive a delegated child's initial link so a lost claim race is permanent, not retryable

`rundown claim` derived the parent link for a delegated child **outside** the
transaction that commits it: `captureRunAuthorityState` read the parent at
version _v_, `prepareDelegationChildLink` derived against _v_, and
`claimAndInitialLink` fenced the write on _v_. When a second claimer of one
token captured before the winner committed, the fence saw a moved version and
refused `concurrent_modification` — surfaced as `CONCURRENT_MODIFICATION`, whose
message is "Retry." The delegation was in fact permanently taken, and no retry
could ever succeed. A bare version mismatch carries no reason for the move, so
only re-deriving can tell the two apart.

The claim pipeline now re-derives capture → prepare → commit while the commit
keeps losing, on the store's own optimistic budget (`DEFAULT_MUTATE_ATTEMPTS`
attempts, `mutateBackoffMs` jittered pacing — both now exported from
`@rundown-org/core` so the budget has one definition). A loser re-derives
against the row the winner committed and reports the permanent
`DELEGATION_ALREADY_CLAIMED`. Only the commit's `concurrent_modification` is
retried; every preparation refusal is permanent and returns immediately.
Exhausting the budget still reports `CONCURRENT_MODIFICATION`, which by then is
a genuine sustained race rather than a guess.

The refusal also names the right run. `already_linked` now carries
`occupyingChildRunId` — the child that _holds_ the delegation — and
`DELEGATION_ALREADY_CLAIMED` reports it. Previously this arm named the claimer's
own freshly launched child, a run its launch cleanup then deleted. On the
fresh-launch path that arm was additionally reported as
`CLAIM_INVARIANT_VIOLATED` (RD-820), blaming Rundown for a race it handled
correctly; it is now the typed `DELEGATION_ALREADY_CLAIMED`, alongside the
`parent-missing` and `concurrent-modification` races already treated that way.

`DelegationChildLinkPreparationError` now takes a discriminated
`DelegationChildLinkRefusal` payload in place of a bare `reason` string, so the
occupying child cannot be omitted from the one arm that has one. Consumers
reading `error.reason` read `error.refusal.reason`.

Closing this gap was the prerequisite for retiring the `DelegationLock` held
over `rundown claim`, which #690 has since deleted.
