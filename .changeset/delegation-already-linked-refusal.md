---
'@rundown-org/core': minor
'@rundown-org/cli': minor
---

# Refuse an occupied delegation as already-claimed, not as a retryable race

`deriveDelegationChildLinkedSubsteps` classified "this delegation is already
linked to a different child" as `concurrent_modification`. That is a permanent
condition, not a version race: a delegation names one child for the life of the
entry, so re-reading can never free it. The misclassification reached the user
through `rundown claim` as `CONCURRENT_MODIFICATION`, whose message is "The
parent changed while the delegated child claim was being committed. Retry." — a
claim that can never succeed, told to retry.

The derivation now raises a new `already_linked` reason, and the claim pipeline
maps it to the existing `DELEGATION_ALREADY_CLAIMED` refusal — the same no-retry
outcome the already-linked re-read path reports for the same fact.
`concurrent_modification` is unchanged and still names the genuine
compare-and-swap race; the two reasons stay distinct.

`PrepareDelegationChildLinkResult` and `PrepareDelegationChildUnlinkResult` gain
an `already_linked` arm, exported as the shared
`PrepareDelegationChildLinkRefusal`. Consumers that switch exhaustively on
`kind` must handle it.

Until now the misclassification was masked by the `DelegationLock` serialising
concurrent claims, so the loser re-read and took the already-claimed path
instead. Fixing it is a prerequisite for retiring that lock (#690).
