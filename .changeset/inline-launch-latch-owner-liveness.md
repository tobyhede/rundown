---
'@rundown-org/core': patch
'@rundown-org/cli': patch
---

# Reclaim an inline-launch latch whose owner is no longer running

The inline-launch latch is committed before the child run is created — that
ordering is what makes the launch exactly-once — and it opened a window: a
process that died between the latch and `manager.create` left the launch latched
with no child, and every later observer classified itself `already-latched` and
reported `waiting`. Indefinitely, and with no diagnostic naming the condition.

This is best read as a property the compare-and-latch **dropped**, not a hazard
it introduced. The `DelegationLock` it replaced already recovered a crashed
holder, through PID-aware stale reclamation. The fix is to give the latch the
same property, on the same terms the file locks state: reclamation is a liveness
decision and **never** an age-based one.

The latch therefore records who holds it. `substepStates[].inline.started` is
now `{ at, ownerPid, ownerStartId }` — one value rather than a bare timestamp,
so a start with no owner to check is unrepresentable — and
`INLINE_CHILD_STARTED` carries the same. `classifyInlineLaunchOwnership` (new,
exported from `@rundown-org/core`) reads it as `unlatched`, `held` or
`reclaimable`, over the same `isOwnerAlive` probe the execution lease uses. A
**start id**, not a bare pid: a recycled pid would otherwise read as a live
owner and the latch would never be reclaimed. Every unknown answers "alive", so
a host that supplies no start id degrades to the pid-only decision rather than
reclaiming on a guess.

An observer that finds a dead owner takes the launch over, records **itself** as
the new owner in the same commit — so a third observer finds it held rather than
reclaiming a launch now in progress — and warns that it did so. An observer that
finds a live owner still stands down with `waiting`, and now names the process
holding the launch instead of waiting opaquely.

Absence of the child run row is deliberately not the signal, and the reasoning
is worth recording because the cheap fix looks sound: an observer that has
latched and is still resolving the child runbook presents _exactly_ the state a
crashed one does. Reclaiming on absence would send both into `manager.create`
and reproduce the `SQLITE_CONSTRAINT` race the latch exists to prevent. Only
liveness separates _dead_ from _not there yet_.

Persisted state carrying the old bare-timestamp `startedAt` no longer validates.
Per the no-migration rule, finish, stop, or prune an affected run rather than
expecting it to load. Closes #753.
