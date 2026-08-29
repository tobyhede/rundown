---
'@rundown-org/cli': patch
'@rundown-org/core': patch
---

Move inline child launch and upward completion flow-back behind the core Run
Progression activation. Fresh children and composing parents now re-enter the
same XState-owned progression seam, with exact linkage validation and run-scoped
delegation authority at every ancestor.

The flow-back reports the child's terminal through the same
`projectDelegationTerminalOutcome` projection the completion service and the
legacy upward walk use, so a child stopped by a denied policy or a command the
runner could not execute is refused fail-closed instead of reported upward as an
authored FAIL the runbook never produced. The ancestry walk keeps the
`MAX_INLINE_PROPAGATION_CHAIN` depth bound alongside its cycle guard, every
refusal it returns delivers its diagnostic through the gated observation sink
before flipping the exit code, and a parent that cancelled the composing substep
is reported as owing nothing rather than as a failure.

Because the inline linkage-cycle refusal is now diagnosed inside core and
delivered through the gated observation sink, `rundown pass` on a corrupt inline
chain reports it as the `error_occurred` execution event rather than the CLI's
own `error` envelope. The code (`INLINE_PARENT_CYCLE`), the message naming the
run to prune, its `cause`/`runId` details, and the non-zero exit are unchanged.
`rundown complete` still refuses through the unmigrated force-terminal plan and
keeps its `error` envelope.
