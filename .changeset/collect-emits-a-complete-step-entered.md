---
'@rundown-org/core': minor
---

# `rundown collect` emits the same `STEP_ENTERED` as `rundown run`

Entering substep `1.1` via `rundown run` produced a `STEP_ENTERED` carrying its
description and prompt. Entering the same substep of the same runbook via the
RETRY re-entry `rundown collect` drives produced one carrying neither. Two
functions built the payload's `StepEntryMetadata` and they disagreed: the CLI
execution loop rendered every field, and the collection service hand-built ids,
position, name and flags with every rendered field absent. All four are optional
on the type, which is what let the disagreement compile.

The collect path now enters through the same core seam the loop does. The
hand-built entry is gone, along with the Stryker equivalence annotations that
existed only because half the fields it built were never observed.

Three assertions flip with it, each pinned by #816 against the old behaviour:

- The rendered fields. `description` and `prompt` are present on the collect
  payload, end to end, and equal to the run payload's for the same unit.
- `prompted`. The collect path read `!!state.prompted` alone; it now composes
  the persisted flag with the step kind, so a prompted-FOR step reports `true`
  on both paths.
- `substepId`. It came off the raw cursor while `isSubstep` came off the
  resolved unit, so a cursor naming no live substep produced a populated
  `substepId` beside `isSubstep: false`. Both answer one question and both now
  come off the resolved unit — which matters beyond tidiness, because the
  frontier seams gate credential disclosure on `isSubstep`.

**The fenced frontier seam sheds its `entry` parameter**, as its unfenced twin
already had. `prepareReEntryFrontierConsume` derives the substep question from
the state it holds and returns the projected bearers rather than an entry, so
there is no longer any route by which a caller can hand either seam an entry
that disagrees with the run.

**Two guards are deleted rather than left unreachable.**
`deriveStepEnteredEffect` refused an entry whose `stepId` / `substepId`
disagreed with the snapshot. Those existed because the entry was a parameter;
with one producer that reads the cursor and the snapshot off the same
`RunbookState`, the mismatch is unrepresentable.
`RunbookActorService.observeExecutionUnitEntry` goes with them — its last caller
was the collect path — and `StepEntryMetadata` becomes a local passed between
two core functions rather than a parameter of anything.

**A new failure surface, named.** A collect that has committed can now fail to
RENDER the entry its bearers ride on — typically a `--helpers` helper raising —
where before it emitted a thinner event that needed no rendering. Nothing
recovers the bearers (the consume is durable, so a retry answers the idempotent
no-op), so the collect still rejects rather than reporting a phantom success
with an empty observation list. It rejects with a code of its own,
`DELEGATION_FRONTIER_DISCLOSURE_FAILED` (RD-833), instead of escaping bare as
RD-999 "Unknown error" — an envelope that cannot carry this condition's
recovery, which is "fix the helper, then re-delegate". A render refusal that is
`InvalidRunbookStateError` keeps its own class, so the CLI's RD-309 arm still
prints finish/stop/prune for a run that cannot describe itself.

Bearer-disclosure ordering is unchanged and still asserted: the commit lands
before the entry is derived, so a refused transaction consumes nothing and
discloses nothing.

**The persisted-snapshot guards are now typed too, and RD-833 depends on it.**
`assertFreshSnapshotValue` and `compileMachineFromState` refuse an unreadable
`snapshot.value`, a transient parent-entry state, a cursor naming a step the
runbook no longer declares, and a missing `frontmatterOutputs` — all one run's
corrupt persisted state, and every message already spelled RD-309's remediation
("Prune invalid runbook state and restart execution"). They threw a bare
`Error`, which reached the CLI as RD-999. They now raise
`InvalidRunbookStateError` with a typed reason, which is what keeps them off
RD-833: without it, a collect whose committed target carried an unparseable
`stateValue` would have told the operator to fix a helper and re-issue
delegations when the real recovery is prune/restart. Every other caller of those
guards gains the RD-309 envelope with them.

One narrowing worth knowing. The artifact-path projection used to fall back to
`WORK_DIR` when a run carried no `WorkPath`, while the render context the same
entry expands helper paths against refused a missing `WorkPath` outright — so
the fallback could only ever produce an entry whose artifact paths and helper
paths named different roots. There is one read now, and a run with no `WorkPath`
is refused as corrupt persisted state on both paths.
