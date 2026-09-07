---
'@rundown-org/cli': patch
---

The scenario harness now derives a scenario's result from the root run's own
lifecycle observation instead of the last terminal-bearing line of output.

`docs/spec/cli-output.md` defines two different things: the streamed
`runbook_completed` / `runbook_stopped` events, which are run-scoped and carry
`runbookId`, and the trailing action object, which is the command's own envelope
for whichever run the command targeted. Inline composition is where those two
part company — `rd pass` on the last child of a `FAIL ANY STOP` step completes
the CHILD while the composing root STOPs — so a positional scan reads the
child's `complete` and reports COMPLETE for a workflow that halted.

This was latent rather than new. Before #854 the parent's propagation events
were emitted by the CLI after `runSeamTransition` had already flushed the
child's envelope, so the root's terminal happened to be the last line and the
positional scan happened to be right. #854 moved progression inside the applied
transition, which puts the streamed observations before the final action object
as the spec requires, and the positional scan then read the wrong run.

`parseJsonLines` takes the root run id (the first `runbook_started` of the
sequence) and prefers a lifecycle terminal scoped to it. Output that carries no
such observation — every single-run scenario — keeps the positional scan
unchanged.
