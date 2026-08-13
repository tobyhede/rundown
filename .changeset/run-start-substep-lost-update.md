---
'@rundown-org/cli': patch
---

# Stop a launched inline child from clobbering its siblings' substep rows

`rundown run <file> --step <id>` marks the parent substep it targets `running`
before the child executes. That write used to load the parent, derive the whole
`substepStates` array from what it read, and commit the array afterwards. Any
substep row another writer committed in between was overwritten by the pre-read
copy — a lost update, not a stale read: the sibling row was already durable, and
the launch put the older array back on top of it.

The derivation now happens inside the compare-and-swap, via
`RunbookStateManager.updateWithStateIfExists`, so the array the launch replaces
is the exact version the write commits onto and a writer that loses the race
re-derives against the committed row. `upsertSubstepState` is pure and
synchronous, so re-running it on each of the CAS's attempts costs nothing and
has no external effect. A parent that has gone missing resolves to `null` and
writes nothing, exactly as the pre-read existence check did.

The site held `DelegationLock` while it did this, and the lock never prevented
it. `DelegationLock` excludes only other `DelegationLock` acquirers — two
launch/claim paths in the CLI — whereas the commands that write a parent's
substep rows (`delegate`, `pass`, `fail`, `goto`, `abort`) go through the state
machine and take no lock at all. So the writers that could lose their row were
never excluded, and were reachable from an ordinary two-agent session: an
orchestrator raising a delegation on substep 1.2 while an inline child is
launched against 1.1.

The acquisition is therefore removed rather than replaced, which also removes a
`DELEGATION_LOCK_TIMEOUT` (RD-810) failure from the launch path. The two
remaining `DelegationLock` sites are untouched — they fence a launch/claim race
rather than a read-derive-write gap. Part of #690.
