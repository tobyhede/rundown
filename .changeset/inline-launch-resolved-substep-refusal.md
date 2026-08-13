---
'@rundown-org/cli': patch
---

# Refuse an inline launch whose target substep is resolved while it launches

`rundown run <file> --step <id>` decided "is this substep already resolved?"
against a parent state read in `buildInlineLinkage`, and then marked the substep
`running` much later — after resolving the runbook ref, reading and parsing the
file, creating the child run, and starting its engine. A `pass`, `fail`, `goto`,
or `abort` that committed anywhere in that window was decided against a state
that no longer existed.

The write itself already derived its array inside the compare-and-swap, so a
concurrent writer's _sibling_ rows survived. The _target_ row did not:
`upsertSubstepState` merges its patch, so the committed
`{status: 'done', result: 'pass'}` became `{status: 'running', result: 'pass'}`
— the resolution erased, the result left behind to contradict it.

That row is evidence, not decoration. Once a resolved completion has been
drained, `substepStates[].status === 'done'` is the only durable record that the
substep was ever resolved — `isDuplicateChildCompletion` falls back to exactly
that field — so reverting it re-opens the substep to a second completion, which
drains and advances the parent a second time over the concurrent writer's
result.

The decision now happens inside the same compare-and-swap as the write, against
the exact version it commits onto: the launch either marks the substep `running`
or refuses, and a loser re-derives against the row the winner committed. The
refusal keeps its own permanent code — `DELEGATION_ALREADY_RESOLVED`, the same
one the pre-read guard emits — rather than the generic `LAUNCH_FAILED` a thrown
`afterInit` would otherwise produce, because a substep that is already resolved
will not become unresolved on a retry. The refused launch writes nothing and its
child run is removed by the existing launch rollback; session activation happens
after `afterInit`, so no session entry leaks.

The pre-read guard stays where it is. It is what turns the common case into a
cheap refusal before any file is read or run is created; the fold is what makes
the guard's answer still true at the moment it is acted on. Both now evaluate
one pure predicate, so they cannot drift.

Part of #690 — this is the residual half of the fold the run-start lost-update
fix began, and the reason that fix's own changeset could say the retired
`DelegationLock` never excluded these writers: it never did, and the target row
was exposed to them too.
