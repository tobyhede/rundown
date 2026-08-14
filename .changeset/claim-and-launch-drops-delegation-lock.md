---
'@rundown-org/cli': patch
---

# Claim a delegation without taking a file lock

`rundown claim` held a `DelegationLock` on the parent run across the whole
reread-to-claim window: re-load the parent, check that the delegation still
exists and is neither cancelled nor already taken, reconstitute context, prepare
and launch the child, and link it. The acquisition, the
`DELEGATION_LOCK_TIMEOUT` (RD-810) failure it could produce, and the
`afterStarted` release that ended the window before the child ran are all
removed, and nothing replaces them.

Nothing replaces them because nothing needs to. Every refusal the lock stood in
for is now decided inside the transaction that commits the fact it depends on:
the parent's liveness against this delegation, an occupied delegation, a
terminal or linkage-divergent child, and the initial parent link itself are all
classified by core's claim transaction against the exact row it fences on. A
second claimer of one token no longer wins a race by holding a file; it
re-derives against the committed row and reports the winner's outcome —
`DELEGATION_ALREADY_CLAIMED`, naming the child that actually holds the
delegation.

Two failure modes go away with the lock. `DELEGATION_LOCK_TIMEOUT` is no longer
reachable from `rundown claim` at all, so concurrent claims against one parent —
including sibling delegations that have nothing to do with each other — can no
longer serialise into a five-second deadline and fail. And a claim no longer
holds a filesystem mutex across a child launch, so a crashed claimer leaves
nothing behind for the next one to reclaim.

`rundown claim`'s successful output is unchanged. The only envelope change is a
removal: the `lock-timeout` failure and its `DELEGATION_LOCK_TIMEOUT` mapping
are gone. The RD-810 code definition itself is untouched, as are the lock
modules; #690 owns deleting those.

This is the last of the six lock sites retired under #690 — no production code
in any package now constructs a `DelegationLock` or a `CompletionLock`.
