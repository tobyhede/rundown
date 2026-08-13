---
'@rundown-org/cli': patch
---

# Anchor a delegated child's linkage to its delegating step

`claimAndLaunch` now builds every delegation linkage with the **delegating**
step — the step the delegation was raised from — instead of the parent's current
cursor position. All three construction sites are affected: the replay linkage,
the orphan-reconciliation linkage, and the fresh-launch linkage that is also
persisted as the child's `parentLinkage`.

Core's claim transaction classifies delegation liveness by comparing the
parent's committed step against `linkage.parentStep`, and
`classifyDelegationLiveness` holds a delegation live only while the parent's
cursor "still sits on the delegating step". Copying `parentStep` from the same
read the check compares it against made that comparison self-fulfilling: it
could fire on the narrow window between the CLI's read and the transaction's
commit, but never on a cursor that had **already** advanced past the delegation
before the claim began. Such a claim was classified live and admitted.

The two values are equal whenever the parent has not moved on, which is why this
never showed up outside a raced or already-superseded claim.

The parent-side half of the latch is fixed by the same change without touching
core: `invalidateClosedDelegatedClaims` classifies against the persisted
`delegation_json`, which is written from this linkage. Claims already persisted
keep the value they were minted with — per the no-migration principle, that is
left alone rather than rewritten.

Prerequisite for the domain-lock deletion in #690: the CLI's pre-claim liveness
check is deleted there, leaving core's in-transaction classification as the sole
owner of this refusal. That is only safe once the classification is fed the step
its contract asks for.
