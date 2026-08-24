---
'@rundown-org/core': patch
---

# Refuse a thenable `releaseOnCommit`, and pin the ordering its correctness rests on

Follow-up to the completion drain's transactional Run Release (#794, merged in
#839), from a second review round over the same diff.

`RunbookStore.mutateState`'s `releaseOnCommit` derivation is declared
`SyncWork`, but only the type half of that contract was enforced. The driver's
runtime half, `assertSyncWorkResult`, never saw this result: it runs at the two
driver boundaries, and the outer transaction callback returns the write outcome
rather than the derivation's value. An untyped caller returning a promise
therefore left `releases.length` `undefined`, failed the emptiness guard, and
**skipped the release while committing the terminal state** — the exact defect
#794 exists to prevent, restored with no error raised. It is now guarded, so the
refusal is loud and rolls the state write back with it.

Two properties the design leans on were documented but unasserted, and both are
invisible to mutation testing because statement reordering is not a mutation
operator:

- **An empty release reads no session.** The test named for it observed only the
  session _write_. `readSession` deserializes every active claim, so a read
  hoisted above the emptiness guard would make one corrupt claim row anywhere in
  the session fail _every_ non-terminal apply, on runs unrelated to it — while
  the whole suite stayed green.
- **The owned-set refusal precedes the session read.** The rollback makes the
  existing state and stack assertions blind to it, so moving the ownership check
  below the projection changed nothing observable, and turned a programmer error
  naming the wrong run into an `InvalidPersistedClaimError` telling the operator
  their database is inconsistent, with a prune recovery that cannot fix it.

Both are now pinned by `readSession` spies, each verified by making the defect
and watching only the new assertion fail, plus a positive control on the happy
path so neither can pass vacuously.

Also corrected: the transaction-ordering rationale claimed the ordering was
forced by claim invalidation. It is not. `invalidateClosedDelegatedClaims`
tombstones rather than deletes, and `applySession` builds `persisted` from all
rows but `stale` from active ones only, so a claim superseded inside the
transaction lands identically whichever side of the write the session was read
on. The order is kept for symmetry with `commitOwnedState`, and the comment now
says so instead of crediting it with an invariant it does not carry. The
previous round removed a different false clause from the same comment.

`RunbookStateManager.mutateStateReturning` now takes
`Pick<MutateStateOptions, 'releaseOnCommit'>` instead of re-spelling the
signature it forwards whole, and the drain's process-test fixture derives its
report types from the service's own result union rather than typing them as
`string`.
