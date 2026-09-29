---
status: accepted
supersedes: ADR 0001, ADR 0002
---

# ADR 0005: One writer per run

Delegated and inline children wrote into their parent's record from separate
processes, so every parent was a multi-writer row. Each race that produced was
patched with another mechanism — compare-and-swap retry budgets, claim
generations, claim rotation, compare-and-latch, supersession tombstones, Run
Release — and core plus CLI grew from 27K to 92K lines while serving six
runbooks that fan out at most four children one level deep. We decided that
every run has exactly one Run Owner, proven by an Owner Token bound to that run,
and that only the owner's commands write it; a concurrent second write is
refused as a usage error, never retried. A child reports only by reaching a
terminal in its own record, and the parent learns it by an explicit Collect,
which is the sole authority on what counts.

Agents are confused often, so the model defends against confusion rather than
against a hostile local user, in layers: a hashed, full-entropy Owner Token on
every mutation (a run ID authorizes nothing); a hashed Claim Ticket that lets
exactly one agent claim a reserved Current Child and never appears in status; a
required `--step`, plus `--index` inside loops; a Current Child reserved afresh
on every entry into a step; a plugin hook that refuses `claim` outside a
sub-agent and a SubagentStop gate over claimed, unfinished children that are
still current and not cancelled; and a human-only, audited escape hatch for a
lost top-level token.

## What survives, and why

The rebuild keeps the mechanisms whose original problem one writer per run does
not remove. Tracing each mechanism to the defect that introduced it showed these
are essential, not artefacts of the multi-writer race:

- **The Claim Ticket** (today's delegation token): a secret handoff kept out of
  status, or any agent reading status could claim a child first.
- **The Owner Token** (today's one-active-claim bearer): stays resolvable until
  pruning, so a late command on a finished run is told it finished (#648). An
  Inline Child is authorized by its parent's token, so a crash before a child
  token is printed cannot strand it.
- **A small execution lease**: a started marker `{attempt, pid, start-id}` set
  by conditional update immediately before an external effect. It stops the
  owner's own retried or parallel command running an effect twice, distinguishes
  a live command (In Progress) from a dead one (Interrupted), and lets a finish
  commit only if its attempt still holds. Rundown never repeats an Interrupted
  command itself.
- **Entry counters**: the Current Child is keyed by frame, so a result from a
  previous GOTO or loop visit cannot be collected on the next (#749).
- **Run Progression's closed outcome, observation-before-next-effect, and inert
  restore** (#849, #833).

## Considered Options

- **Keep children writing the parent, with less machinery.** Rejected: the
  multi-writer invariant is what generated the machinery; thinning it leaves the
  races.
- **A single long-lived daemon as the physical sole writer.** Rejected: a new
  process model that breaks one-invocation-per-command and WebContainer, to
  solve a problem that exists only because of push.
- **Run ID as the only authority, or a reserved child ID as the claim handle.**
  Rejected: agents routinely act on the wrong run, and a handle visible in
  status can be claimed by the wrong agent.
- **Detect-only crash handling with no lease.** Rejected after tracing the
  lease's origin: it re-runs effects on the owner's own retries and cannot tell
  a live command from a dead one.

## Consequences

- There is no session stack, stash, grant, claim rotation, generation fence,
  supersession tombstone, compare-and-swap retry loop, compare-and-latch, report
  mailbox, or execution-recovery state. Adding any of them back reintroduces a
  second writer or a second authority and needs a new ADR.
- `claim` checks that its child is current and not cancelled and inserts it in
  one transaction. A child's own "am I still current" check may race a
  Cancellation; that is harmless because Collect decides.
- A lost Claim Ticket or unclaimed child is recovered by `retry`. A lost child
  Owner Token is recovered by Cancellation and `retry`. There is no re-claim and
  no re-reveal.
- A sub-agent that cannot finish its child, for example because it lost the
  child's Owner Token, runs `rundown release <child-id>`, which records the
  child as abandoned in the child's own record so Collect sees a definite
  result. Release is authorized by the sub-agent's `agent_id`, stamped by the
  plugin's Bash hook and matched against the `agent_id` recorded at claim; it
  grants nothing else. The SubagentStop gate blocks with that instruction and
  then lets the sub-agent stop once the child is finished, abandoned, or
  cancelled. It keeps no counter, so a sub-agent that ignores the instruction
  loops visibly until a human interrupts it; that is accepted. A lost top-level
  token is recovered only by a human, through an interactive, audited `stop`;
  pruning a running run needs its token or the same confirmation.
- The one implicit Collect is an Inline Child's result, read by the same owner
  in the command that finished the child, and read again first by the parent's
  next command after a crash.
- Nested delegation is neither refused nor supported; no code exists for it
  either way.
- Persisted XState snapshots are unchanged by this decision.
- The rebuild is done when the six real delegating runbooks and one scenario per
  confusion mode pass end to end, and two size gates hold: at most 6,400 lines
  of `src` for delegation, authority and concurrency, and at most about 8,600
  for the general machinery it touches. Exceeding either triggers a design
  review, not a higher limit.
