# ADR 0001: Fold Run Release into the owning transaction

- **Status:** Accepted
- **Date:** 2026-08-25

## Scope

This decision governs inline-composed runbook frames executed by one harness.
Nested subagent delegation is explicitly out of scope and unsupported by
Rundown's target harnesses. An inline runbook frame never represents a
`subagent -> subagent` relationship.

## Context

A terminal run is no longer an active session-stack member. Committing terminal
state before removing that run from session targeting creates a crash gap: a
process can die between the two writes and leave the session targeting a
finished run.

Call-frame release ownership does not close that gap. Re-entrant inline
progression can create two frames that each believe they own the same release,
while a refusal can release a still-running run even though it committed no
terminal transition.

## Decision

Machine-owned Run Release is a synchronous projection inside the database
transaction that commits the corresponding terminal run-state mutation. It is
not a machine-invoked actor because an actor runs outside that transaction.

The owning transaction is the run's own. `RunbookStore.mutateState` enforces the
seam: `releaseOnCommit` refuses a release naming any run other than the run
whose state the transaction writes. Execution frames report progression outcomes
and never negotiate release ownership.

A refusal that applies no terminal transition leaves the running run targeted
and reports the refusal. A run already terminal on entry has no state write to
fold into, so its separately fenced entry path performs the release.

Session-only destruction and recovery paths project their releases inside their
own session transaction. Stack Deactivation remains a separate operation.

## Rejected alternative

Deriving targetability from `stack membership AND lifecycle == running` would
make stale terminal stack rows harmless, but every positional stack and stash
reader and writer would then own part of the invariant. Physical removal keeps
stack membership direct and concentrates correctness at the mutation seam.

## Consequences

- Terminal state and its addressed Run Release commit together or not at all.
- Inline upward progression reloads after the terminal commit; it performs no
  standalone ancestor release.
- Execution-loop results describe progression, not release disposition.
- Refusals cannot report a false terminal event or remove retry authority.
