---
'@rundown-org/core': patch
---

# Back off between contended `mutateState` retries

`RunbookStore.mutateState` now pauses between optimistic retries for a jittered
interval scaled by attempt number (25–50ms × attempt), instead of replaying its
read-modify-write cycle with no delay at all.

Without a pause, every writer that lost a round re-read at the same instant and
they replayed in lockstep: the writer at the back of an N-way queue burned one
attempt per predecessor, so the 8-attempt budget capped the number of
_concurrent writers_ rather than the retry _depth_. Twelve concurrent writers on
one run produced four `concurrent_modification` refusals; they now all commit.

`concurrent_modification` remains a reachable arm — this is still an optimistic
CAS, not a lock, and sustained contention still spends the budget. The added
wait is bounded by the budget at roughly 1.4s, inside the 5s deadline the file
lock this path replaced would have waited, and no pause is taken after the final
attempt.

The `build` callback contract is unchanged: it runs once per attempt and must
stay free of external side effects.

Precondition for the domain-lock deletion in #690, where these paths lose the
file locks that currently serialise them.
