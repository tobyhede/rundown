---
'@rundown-org/cli': patch
---

# Latch an inline child launch so two observers cannot start it twice

An inline launch intent names a fixed child run id. The observer that acted on
it used to check the persisted intent, look for an existing child, and then
create the run — with a `DelegationLock` on the parent held across the whole
span. Two observers of one intent that got past that lock both reached
`manager.create` for the same id, and `RunbookStateManager.save` reads-then-
inserts: the loser hit a bare `INSERT INTO runs` and surfaced an untyped
`SQLITE_CONSTRAINT` throw instead of a typed refusal.

The decision now happens in an atomic compare-and-latch — one prior
`RunbookStateManager.mutateStateReturning` cycle that, against the exact version
it commits onto, refuses an ended parent, stands down on a superseded intent,
refuses a child whose parent linkage does not match, reports an already-latched
launch, or commits `INLINE_CHILD_STARTED` and wins. `inline.started` is the
latch, and only the winner resolves the runbook, prepares it, and creates the
run. An observer that finds the latch taken with no child yet reports `waiting`,
the same answer it gives for a superseded intent.

The launch span stays outside the cycle deliberately: it resolves runbook refs,
reads files, imports modules and emits warnings, and a compare-and-swap build
callback re-runs up to eight times. What it does contain was audited rather than
assumed — `INLINE_CHILD_STARTED` is a root-level handler with no `target`, so
the transition is internal, no state is entered or exited, no actor is invoked,
and entry-time producer ARTIFACTS resolution cannot fire.

Two behaviours are deliberately preserved. Every refusal is decided ahead of the
latch write, because the machine's `inlineLaunchIntentActor` carries `started`
forward into the next intent it prepares for the same substep — a start recorded
for a refused launch would make every later re-entry of that frame report an
already-started launch. And `INLINE_LAUNCH_CONSUMED` still fires after the child
exists, because the one-shot intent surviving that long is what lets an
interrupted launch be re-observed and finished.

One failure moves: a process that dies between the latch and the create leaves
the launch latched with no child, where the previous ordering recovered that
window automatically and paid for it with the duplicate insert. The latch record
names its owner so that window is recoverable too — see the separate note on
reclaiming a latch whose owner is gone, which ships in this same release.

The `DelegationLock` acquisition is removed rather than replaced, taking a
`DELEGATION_LOCK_TIMEOUT` (RD-810) failure off the launch path with it — a
failure that was reachable without any second process at all, because the lock
is not reentrant and an inline launch reached from a composing parent's own loop
could block itself for the full five-second deadline. This covers the
inline-launch acquisition only; the claim-and-launch site needs a different
replacement and is retired separately in this same release. Part of #690.
