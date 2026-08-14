---
'@rundown-org/core': major
'@rundown-org/cli': patch
---

# BREAKING: the resolved-completion drain becomes a single-apply primitive

`RunbookCompletionService.drainResolvedCompletions` and its unlocked twin are
replaced by `applyNextResolvedCompletion`, which applies exactly one completion
per call. `RunbookCompletionService.recordManualCompletion` and
`ExecutionLifecycleService.listResolvedCompletions` are removed, as are the
`DrainResolvedCompletionsArgs` / `DrainResolvedCompletionsResult` types.
`RunbookCompletionService`'s constructor no longer takes an
`ExecutionLifecycleService`.

The drain selected a completion against a caller-supplied `currentState` and
then let `sendAndSync` load its own state to apply against. The compare-and-swap
underneath prevented a lost update, but not a stale derivation: if the cursor
moved between the two, the drain consumed the row for the substep the caller had
captured while raising its PASS on the substep the machine had since advanced
to. The completion landed on the wrong substep, its own substep stayed
`running`, and the passed-over row was left stranded.

`applyNextResolvedCompletion` runs selection, cursor validation, the actor
transition, and the commit inside one `mutateStateReturning` cycle, so the row
it applies is chosen against the exact version the write commits onto and a
losing attempt re-derives rather than replaying a stale pick. It takes no
`currentState` — a caller-supplied state is stale by construction at that seam.
It also retires the last `CompletionLock` acquisition in core.

Callers that drained a frame to exhaustion now loop the primitive until it stops
reporting `applied`. The CLI already did exactly that, one apply at a time, so
that its execution loop could observe and emit each transition before deriving
the next one; it no longer threads state between calls, so a completion recorded
by another process mid-drain is picked up rather than missed.

`RunbookStateManager.mutateStateReturning` is added: a compare-and-swap whose
callback derives the whole next `RunbookState` rather than a patch, for
derivations that already produce one.

The CLI's own contract — commands, flags, JSON envelopes, exit codes — is
unchanged.
