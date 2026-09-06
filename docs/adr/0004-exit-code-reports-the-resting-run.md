# ADR 0004: The exit code reports the run where progression rests

- **Status:** Accepted
- **Date:** 2026-09-06

## Scope

This decision governs the **process exit code** of the commands that can drive a
run to a terminal: `rundown run`, `rundown goto`, `rundown pass`,
`rundown fail`. It does not govern the step result (`pass` / `fail`), the
durable lifecycle, or the event stream — those are separate channels and this
decision changes none of them. It does not govern `rundown stop` /
`rundown complete`, whose exit is the operator's own requested terminal.

## Context

Run Progression returns one closed outcome (ADR 0003). Every non-terminal
outcome identifies **the run where progression yielded**, which for an inline
child is the composing parent, not the child the caller named.

The rule for turning that outcome into an exit code was written down for `pass`
/ `fail` only, in `docs/reference/cli.md`. `run` and `goto` were never covered,
and they drifted. Measured on `main`, with the failure mechanism held constant —
an auto-executed command exiting non-zero under `FAIL STOP`, and a composing
parent that defers to a pending sibling and keeps running:

```
run  carries the stop     exit=1     parent=running  child=stopped
pass carries the stop     exit=0     parent=running  child=stopped
goto carries the stop     exit=1     parent=running  child=stopped
```

Three commands, one set of run states, two answers. The difference was the verb,
not the state. `pass` alone followed the documented rule.

The drift was invisible for three months because the pre-migration `run` and
`goto` paths derived their exit from the child's own execution-loop status,
while `pass` derived it from the composition. Moving Run Progression into the
machine (#851-#858) removed the loop, so all three now read the same closed
outcome — and the disagreement surfaced as a failing test rather than as a
behaviour change anyone had chosen.

## Decision

**The exit code answers one question: has the workflow this process drives
halted?** It is derived from the run where progression came to rest, never from
the run the caller named.

- Exit non-zero when the resting run reached `stopped`, RETRY was exhausted, or
  the turn refused or failed to deliver its observations.
- Exit 0 otherwise, including when a named child reached a `stopped` terminal
  and the composing parent absorbed it and kept progressing.
- For a run with no composing parent, the resting run is that run itself, so its
  own terminal decides.
- The rule is identical for all four commands. It is documented once, for all
  four, in `docs/reference/cli.md`.

Absorption is not a softer handler. It is `FAIL ANY` aggregation that has not
fired yet because a sibling substep is still pending. The same parent halts once
that sibling resolves, and the exit code then reports the halt.

## Alternatives rejected

- **Converge on exit 1 — make every command report the run it named.** This
  reverses a decision taken deliberately in June, when the `pass` / `fail`
  contract was written and the composition scenario fixtures were changed from
  `! rd fail` to `rd fail`. It would require carrying the initiating run's
  terminal through all 11 paths on which the outcome can name another run, and
  reviewing 46 core assertions that pin `runId`. It also makes `rundown fail`
  report failure while the orchestrated workflow is still progressing, which is
  the exact case the June change fixed.
- **Keep both, and document `run` and `goto` as a different contract.** An agent
  would have to learn two rules for one set of run states. The documented
  audience for the exit code is a scripted orchestrator; two rules defeat it.

## Consequences

- **Exit 0 does not mean no run stopped.** The child's `runbook_stopped` event
  is still emitted on the JSON stream when the parent absorbs it. The exit code
  is the halt signal; the event stream is the failure signal. This split is
  stated in `docs/reference/cli.md`, and an agent that branches only on the exit
  code will miss an absorbed child terminal by design.
- A caller cannot learn a named run's own terminal from the closed outcome. That
  is accepted: `RunProgressionOutcome.runId` names the resting run, and callers
  that need the named run's identity already carry it separately (`stateId`,
  `childRunId`).
- `packages/cli/__tests__/integration/exit-code-contract.test.ts` pins the rule
  across `run`, `pass` and `goto` with one failure mechanism, so a future change
  that moves one command cannot pass while the others stay put.
