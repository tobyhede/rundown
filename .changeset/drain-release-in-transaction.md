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

`RunbookStore.mutateState` now accepts a `releaseOnCommit` derivation, applied
inside the transaction that performs the compare-and-swap write, after the state
lands and only on the attempt that commits.
`RunbookStateManager.mutateStateReturning` threads it through, and
`applyNextResolvedCompletion` takes a `terminalRelease` that uses it: an apply
whose prepared state reaches a terminal lifecycle projects
`{ runId, role: 'addressed' }` before the transaction closes. Either both writes
land or neither does.

Ordering inside the transaction matches the fence's, and for one of the fence's
two reasons: the state write goes first, because it invalidates closed delegated
claims in that same transaction — a session read before it would project onto a
claim set the write is about to change. The fence's other reason does not carry
over. Its owned write clears execution ownership; the compare-and-swap only
requires `exec_token IS NULL`, which is why the refusal below is subsumed rather
than relocated.

The option is release-shaped rather than the free-form session projection the
owned-commit methods take. This cycle owns exactly ONE run, so the store states
and enforces the owned-set rule itself instead of trusting each caller to
restate it. It also makes an empty answer free: the session is read and
rewritten only when there is something to project, so a caller arms the option
once for a whole drain and every non-terminal iteration still touches no session
row — and cannot fail on one either, since a corrupt claim row elsewhere in the
session is only ever read when a release is actually due.

## Atomic projection, not predicted terminality

Every terminalizing driver arms `terminalRelease`; the inline upward seam owns
no later cleanup. An armed release is inert on every non-terminal apply, so a
drain arms it once and lets each transaction decide.

The trigger cannot be spelled the same way. Whether an apply reaches terminal is
decided by the transition prepared inside the transaction, long after the
argument is built, so it is read from the state being committed rather than
asserted by the caller.

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
- Two refusals `SessionService.releaseRuns` could return on this path are
  retired rather than relocated. `execution_in_progress` is now unreachable
  because the same transaction's compare-and-swap already requires
  `exec_token IS NULL`, and `recovery_required` because an abandoned run keeps
  its `exec_token`, so the apply refuses before a release is even considered.

The entry-time terminal checks still release through
`SessionService.releaseRuns`. An already-terminal run has no state write to fold
a release into; fencing that one against captured authority is #734.

## Inline progression uses the same atomic boundary

The inline parent-advance drain also arms `terminalRelease`. If it reaches
terminal, parent state and addressed release commit together; the upward seam
then reloads and continues progression without a standalone release. Re-entrant
flow-back returns an ownership-neutral handled/blocked status so an enclosing
frame stands down without losing failure severity.

Closes #794. Part of #781.
