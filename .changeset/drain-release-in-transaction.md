---
'@rundown-org/core': minor
'@rundown-org/cli': minor
---

# The completion drain releases in the transaction that commits its terminal

A run that the completion drain drove to terminal committed its terminal state
in one transaction and left the session's targeting structures in another, four
stack frames later. A process that died in between left a finished run the
session still resolved to — and nothing heals that: no path removes a loadable
terminal run, so every later bare command kept selecting it.

The command fence has never had this gap. It folds its release into the same
owned commit as the state write, and `collect` does the same through the
aggregate seam. The drain was the one terminal path still doing it in two steps,
because it does not run under an execution lease — its whole read-derive-write
span is one optimistic compare-and-swap, and that seam had no way to write the
session at all.

## What changed

`RunbookStore.mutateState` now accepts an `updateSession` projection, applied
inside the transaction that performs the compare-and-swap write, after the state
lands and only on the attempt that commits.
`RunbookStateManager.mutateStateReturning` threads it through, and
`applyNextResolvedCompletion` takes a `terminalRelease` that uses it: an apply
whose prepared state reaches a terminal lifecycle projects
`{ runId, role: 'addressed' }` before the transaction closes. Either both writes
land or neither does.

Ordering inside the transaction matches the fence's, and for the fence's reason:
the state write goes first so the resolution-affecting claim triggers see the
authoritative row already updated.

## Ownership, not terminality

`terminalRelease` says who owns the release, and nothing else. The execution
loop arms it exactly where it arms the fence's — under loop ownership — and
leaves it absent under caller ownership, where the inline parent-advance seam
releases once for the parent it drives. An armed release is inert on every
non-terminal apply, so a drain arms it once and lets each transaction decide.

The trigger cannot be spelled the same way. Whether an apply reaches terminal is
decided by the transition prepared inside the transaction, long after the
argument is built, so it is read from the state being committed rather than
asserted by the caller. The projection also refuses to release any run but the
one its transaction owns — releasing another would be an unfenced session write,
which is the refusal the aggregate seam already raises for an out-of-set
release.

## What a caller sees

- The drain's `done` and `stopped` arms take no second release. Idempotence is a
  safety property, not permission to issue the operation twice.
- A refused release can no longer downgrade a `'done'` to `'stopped'`, because
  there is no second operation left to refuse: a projection that throws rolls
  the terminal state back with it, so the apply never reports terminal at all.
- The corrective `RUNBOOK_STOPPED` those arms emitted on a refused release is
  gone with them, and so is the re-read that named its position. Nothing else
  passed a corrective position, so `applyAddressedRunRelease` and
  `releaseTerminalRun` lost that parameter. The drain's cursor-mismatch refusal
  still re-reads the committed cursor for its own stop — that arm leaves the run
  RUNNING and has no transaction to fold into.

The entry-time terminal checks still release through
`SessionService.releaseRuns`. An already-terminal run has no state write to fold
a release into; fencing that one against captured authority is #734.

Closes #794. Part of #781.
