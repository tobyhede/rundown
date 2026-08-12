---
'@rundown-org/core': patch
---

# Move the completion recorders off their domain locks

`RunbookCompletionService.recordManualCompletion` and `recordChildCompletion` no
longer acquire `CompletionLock` / `DelegationLock`. Each held its lock across a
read-derive-write span — load state, classify the target, commit a patch derived
from that earlier read — and the lock existed only to keep another writer out of
the gap between the decision and the commit. The classification now runs inside
the `mutateState` build callback, so it is derived from the exact version the
compare-and-swap commits onto and a writer that loses the race re-derives
against the committed row and reports `duplicate` instead of overwriting it.

This removes the `DelegationLock → CompletionLock` ordering edge rather than
documenting it. The child recorder used to record through the manual recorder,
acquiring the second lock inside the first; it now commits its own patch from a
shared decision owner, `classifyChildCompletionTarget`, which the fenced
`prepareChildCompletion` also uses so the two can never disagree.

Removed public methods, all of which existed only to expose the locked
recorders' unlocked halves:

- `recordManualCompletionUnlocked` — the locked wrapper was its only caller.
- `recordChildCompletionUnlocked` — same.
- `supersedeDelegationOutcomeUnlocked` — zero callers, and its documented
  contract ("caller must already hold the parent run's DelegationLock") named a
  lock no surviving path takes.

`RunbookStateManager.updateWithStateReturning` gained an optional `guard` write
option, matching its `update` / `updateWithState` siblings, so the manual
recorder can keep forwarding its parent-advance guard.

Behaviour change: `recordManualCompletion` now throws when the parent run does
not exist, in every case. It previously threw only when the target classified as
recordable, and reported `duplicate` for a missing run whose caller-supplied
state looked already-resolved.

`drainResolvedCompletions` keeps its `CompletionLock`. Its per-completion commit
is deliberate — only the first apply carries the parent-advance guard — so
folding it into a single cycle is a design change, not a refactor.

Refs #690.
