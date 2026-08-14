---
'@rundown-org/cli': patch
---

# Anchor a delegated child's linkage to its delegating step

`claimAndLaunch` now builds one delegation linkage, carrying the **delegating**
step — the step the delegation was raised from — instead of the parent's current
cursor position. Every claim route presents that same value: replay, orphan
reconciliation, existing-claim reuse, and the fresh launch that also persists it
as the child's `parentLinkage`. The entry coordinate alongside it is read from
the delegation's issuance credential rather than recomputed from the parent's
live frame history, for the same reason and against the same class of defect.

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

This was the prerequisite for the domain-lock deletion in #690, which has since
deleted the CLI's pre-claim liveness check. Core's in-transaction classification
is now the sole owner of this refusal, and that is only safe because the
classification is fed the coordinates its contract asks for.
