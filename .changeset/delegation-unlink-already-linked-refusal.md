---
'@rundown-org/core': minor
'@rundown-org/cli': minor
---

# Refuse an occupied delegation as already-linked on the unlink path too

`deriveDelegationChildUnlinkedSubsteps` still classified "this delegation is
linked to a different child" as `concurrent_modification` — the same
misclassification that was corrected on the link path. It is a permanent
condition, not a version race: a delegation names one child for the life of the
entry, so no re-read can make it name the child a rollback is trying to unlink.

The unlink derivation now raises `already_linked` with `occupyingChildRunId`,
matching the link path. The refusal did not previously reach a user as an error
code — its only consumer, the launch-rollback warning, reads `.message` and
never `.reason` — so the defect was in the model rather than in the output. It
is fixed before anything routes it to a code and inherits the wrong one.

`concurrent_modification` is removed from `DelegationChildLinkRefusal`, and so
from `PrepareDelegationChildLinkResult` / `PrepareDelegationChildUnlinkResult`.
Neither derivation could raise it: both are pure functions of one captured
`substepStates` array and see no row version, so they cannot observe a race.
Keeping the arm would have left the same over-wide union the `already_linked`
fix exists to close, just under a different name. The race is unchanged where it
is genuinely detected — `SessionService.claimAndInitialLink` and
`rollbackInitialLink` still return `concurrent_modification` from their
compare-and-swap, and the CLI's re-derive loop still retries only that.
Consumers that switched exhaustively on the preparation `kind` must drop the
`concurrent_modification` arm; the commit's is untouched.

The launch-rollback warning now distinguishes the two permanent refusals.
`already_linked` means another child holds the delegation, so this child's link
is already gone and there is nothing to roll back — the warning says so instead
of reporting a rollback that failed.
