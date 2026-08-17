---
'@rundown-org/core': patch
---

# Move the positional pop out of product reach

`SessionService.popRunbook` has had zero product callers since the execution
loop's terminal release moved onto `releaseRunbook(runbookId)`. What remained
was a public method that authorizes on **position** rather than identity: it
re-reads the stack inside its own transaction and releases whatever is on top by
then, so a run pushed between a caller's decision and this write is the run that
gets removed. Because the release deletes every claim controlling what it
removes, a foreign run pushed-and-claimed by `rundown run` loses the run-control
bearer its orchestrator still holds — and re-minting is refused once that run
has issued a delegation. Leaving the method reachable leaves that defect one
call site away.

Moved to `@rundown-org/core/testing/session-fixtures` as
`popTopOfStackUnverified`, following `stashRunbookUnverified` verbatim: the same
"test-only, and here is exactly which defect living here prevents" shape, for
the same reason.

Each alternative was worse. `@deprecated` leaves it callable, which is the one
thing this move is for. A lint fence fences a method that should not exist.
Deleting it outright would push several core tests onto `releaseRunbook` and
quietly change what they assert — they set up multi-level stacks and unwind them
to a known depth, where naming no id is the point.

Both production shapes name their run, and the doc comments now say which to
reach for: `popRunbookIfActive` for an undo of an activation the caller
performed, `releaseRunbook` for a terminal release that must reach its run
wherever it now sits. `topOfStack` stays — `stash` uses it whole and
`popRunbookIfActive` narrows it — with its comment corrected, since it named two
positional callers and there is now one.

This is a breaking change only for a consumer calling
`SessionService.popRunbook` directly. Nothing in this repo does, and the
method's whole problem was that calling it was unsafe.
