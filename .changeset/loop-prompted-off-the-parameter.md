---
'@rundown-org/core': patch
'@rundown-org/cli': patch
---

# `runExecutionLoop` reads `prompted` off the run, not off a parameter

`runExecutionLoop` took `prompted: boolean` as its fifth argument. Every one of
its six call sites passed the run's own persisted flag — four of them spelled
`!!state.prompted` or the equivalent, and the other two (`transitions.ts`,
`runbook-pipeline.ts`) passed a value core had already derived from
`Boolean(state.prompted)` or written to the row with `manager.create`. The loop
loads that same state on its first line.

So the parameter was never a way to configure the loop. It was a way for a
caller to disagree with state about a fact state owns, and nothing in the tree
used it that way. It is gone; the loop derives `prompted` once from the state it
loads, above the `while`, because the flag is fixed at run creation and cannot
vary across iterations.

`launchInlineChildFromIntent` keeps its own `prompted` parameter, and that is
not the same fact: on the fresh-child branch it is the value the composing
parent _inherits down_ into a child run that does not exist yet and therefore
has no persisted flag to read. The resumed-child branch beside it already read
`!!existingChild.prompted` rather than the parameter.

Behaviour-neutral prefactor for #799: the entry seam that follows derives
`prompted` from state, so the parameter had to go either way, and removing it
first keeps that change to one concern.

`LifecycleLoopDirective`'s `prompted` field goes with it. It existed only to
feed that argument from `runSeamTransition`; with the argument gone it is a
second copy of a persisted flag, and a second copy is a way to disagree. The
directive now says only whether to run the loop, which is the one thing the
frontend cannot decide for itself.
