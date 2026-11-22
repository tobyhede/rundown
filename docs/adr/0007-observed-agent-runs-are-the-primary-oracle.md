# ADR 0007: Observed agent runs are the primary oracle

- **Status:** Accepted (not yet built)
- **Date:** 2026-11-23

Between late July and late November 2026, none of the 137 issues opened could be
traced to a real agent failing to run a runbook. About 42 came from code review
or audit, about 25 from mutation testing, and 28 were slices of rebuilds those
findings motivated. Over the same period the delegation area was rebuilt four
times, and the rebuild spec records that the six plugin runbooks that depend on
delegation have never passed end to end. The 15 to 20 defects that did come from
real runs all date from three weeks ending 4 July, and they were concrete and
cheap to root-cause. We decided that a real agent running a runbook in the clean
container is the primary source of defects and the acceptance gate for
agent-facing behaviour, and that review, audit and mutation findings rank below
an observed failure.

The loop has two halves. A **case run** drives a real agent through one runbook
in the container and leaves an evidence bundle with a machine-readable verdict.
A failure seen there is reduced to a deterministic scenario, which is the
witness the issue tracker already requires; the fix is made against the
scenario, then confirmed by running the case again.

The verdict is computed outside the packages, from what the CLI printed: the
agent's transcript, which carries every `rundown` command and its JSON envelope,
and a read-only `rundown status` taken as the container exits. It never reads
`.rundown/rundown.db` and never re-derives run state. The database is copied out
as evidence only.

## Considered options

- **Keep review and mutation testing as the main source of work.** Rejected:
  both produce findings without limit, and neither says whether an agent can
  finish a runbook. This is the loop that did not converge.
- **Treat the scenario suites as end to end.** Rejected as sufficient on their
  own: their sub-agents are scripted, so they cannot show an agent misreading a
  skill or an error message. They stay as the fast, deterministic half.
- **Compute the verdict from the database, or persist an event log in core.**
  Rejected for now: reading state directly would put a second reading of run
  state outside the state machine, and an event log is a core design change this
  decision does not need. The transcript already is the event log.

## Consequences

- A failure where rundown refused correctly and the agent was confused has no
  deterministic witness. It is pinned only by its rate across repeated case
  runs, and the fix is in a skill or an error message, not in core.
- Case runs cost minutes and model usage, and their result varies between runs.
  They do not belong in `pnpm run verify`.
- A "passes end to end" claim for agent-facing work needs a case run to back it.
  A scenario suite alone does not support the claim.
