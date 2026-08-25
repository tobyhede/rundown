---
'@rundown-org/cli': minor
---

# The execution loop states what it did about the run's Run Release

`runExecutionLoop` returned `'done' | 'stopped' | 'waiting'`, and a caller
deciding whether to release the run it had just driven had to infer the answer
from that. It cannot be inferred: `'done'` is `'done'` whether the loop released
the run or deliberately left it targeted for its caller to release. The loop
also built its own `SessionService` privately, so a release it took was
invisible from outside — every existing assertion about release ownership is an
assertion about what the loop RETURNS, and a second owner releasing the same run
changes nothing it returns.

That is not a hypothetical. On a three-level inline chain the inline
parent-advance seam releases the same parent twice (#842), and 31 mock
assertions about single ownership stayed green through it.

Two changes, no behaviour change:

- `ExecutionLoopResult` becomes `{ status, release }`. `status` is the run's
  outcome, unchanged; `ExecutionLoopStatus` is the string union it used to be.
  `release` is an `ExecutionReleaseDisposition` — `'released'`, `'refused'`,
  `'deferred'` (the caller owns it), or `'none'` (none was owed). The two are
  independent facts and are now spelled as two. `ExecutionLoopRefusal`
  discriminates on `status: 'refused'` rather than `kind`, so one discriminant
  covers the whole union and the inline parent-advance callable exhausts it with
  a `switch` instead of reaching its refusal arm by eliminating three strings.
- `ExecutionLoopOptions.sessionService` injects the session the loop releases
  through, defaulting to the one it builds itself. `startRunbook` and the inline
  child launch pass the session the rest of the launch used, so a caller
  watching one session sees the pushes, the claims, and the loop's own release
  rather than a split view of them.

The disposition is a statement about what THIS loop did, never about the run's
session targeting as a whole. The inline flow-back is where the two come apart
and reports `'none'`: the status that returns from an inline launch describes
the child, while the parent may already be off targeting because the seam the
child's terminal entered released it one frame deeper. Naming that `'none'`
makes #842 a visible discrepancy rather than an invisible one; closing it is
#838's fold, not this change.

Groundwork for #838, where Run Release becomes a property of the transaction
that commits a run's terminal state and `releaseOwner` — and with it the
`'deferred'` disposition — is deleted.
