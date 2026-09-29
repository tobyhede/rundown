# Context Map

Rundown defines executable runbooks and the lifecycle of their runs, delegation,
and orchestration authority.

## Contexts

The five packages are the contexts: `parser`, `core`, `cli`, `mcp` and
`claude-code-plugin`. `cli`, `mcp` and `claude-code-plugin` are thin front ends
onto the `core` state machine. Per-package glossaries are created as their terms
are resolved.

## Shared language

These terms cross package boundaries: runs and their ownership are decided in
`core`, presented by `cli` and `mcp`, and enforced in part by
`claude-code-plugin` hooks.

### Runs and ownership

**Run Owner**: The single agent whose commands may write a run. Every run has
exactly one; a second concurrent writer is a usage error, never a race to
resolve. _Avoid_: claim holder, controller, writer

**Owner Token**: The secret, bound to exactly one run, that proves a command
comes from that run's owner. It is given only to the run's creator and never
displayed afterwards; a run ID alone authorizes nothing. It stays resolvable
until the run is pruned, so a command on a finished run is told the run
finished. An Inline Child has no token of its own: its parent's Owner Token
authorizes it. _Avoid_: claim, claim ID, bearer, run-control claim

**Claim Ticket**: The secret a parent issues for one reserved Current Child,
handed to the delegate's agent so it can claim that child exactly once. It
appears only in the step-entry frontier and the dispatch, never in status.
_Avoid_: delegation token, token (alone), reserved ID

**Child Run**: A run started for a step of another run (its parent). It is a run
in its own right, with its own owner and its own record. _Avoid_: sub-run,
nested run, frame

**Delegation**: A Child Run whose owner is a different agent from the parent's
owner. _Avoid_: delegated claim, bearer claim

**Inline Child**: A Child Run owned by the same agent as its parent. _Avoid_:
inline composition, embedded runbook

**Child Result**: The terminal outcome a Child Run records in its own record:
passed, failed, or abandoned. It is the child's only report; a child never
writes its parent. _Avoid_: completion report, resolved completion, report row

**Collect**: The parent owner reading its current Child Results into the parent.
It is the only way a child's outcome reaches the parent. _Avoid_: drain,
flow-back, upward propagation

**Current Child**: The one Child Run a parent step currently counts, named in
the parent's own record, for one entry into that step: each loop iteration and
each re-entry by GOTO or RETRY reserves a new one. The parent reserves its ID
before any agent claims it. Any other child of that step is stale and is ignored
by Collect. _Avoid_: generation, active delegation, live claim

**Cancellation**: A parent owner's decision, recorded in the parent's own
record, that a Delegation no longer counts. The cancelled child learns of it on
its next command and is refused; retry is Cancellation followed by a new Current
Child. _Avoid_: abort-writes-child, supersession, revocation

**In Progress**: The condition of a step whose command is running in a live
process. A second attempt at it is refused. _Avoid_: leased, claimed, executing

**Release**: A sub-agent giving up a Delegation it claimed but cannot finish,
recording the child as abandoned. It is authorized by the claiming agent's
identity, not by the Owner Token. _Avoid_: abort, cancel (the parent's act), Run
Release

**Interrupted**: The condition of a step whose command began in a process that
died before its finish was recorded. Rundown reports it and never repeats the
command itself; the owner decides what to do. _Avoid_: recovery pending, unknown
outcome, needs recovery

**Refusal Hand-back**: A refusal returned to its caller that applied nothing,
leaving the run exactly as it was. It is never announced as a stop. _Avoid_:
release, stop, terminal refusal

**Run Progression**: Driving a run through its authored behavior until it awaits
external input, hands back a refusal, or reaches a terminal. When an Inline
Child reaches a terminal, the same owner Collects it and progression continues
in the parent. _Avoid_: Execution loop, continuation orchestration

### Retiring with the one-writer model

These name mechanisms of the multi-writer model that the Run Owner model
replaces. Do not use them for new design.

**Session Stack**: A per-session stack of active runs, plus a stash slot, that
bare commands target. Replaced by naming the run's Owner Token on every
mutation. _Avoid_: active run, current runbook, stack top

**Run Release**: Removal of a run from every session targeting structure,
together with the disposition of claims it controls. _Avoid_: Terminal release,
stack pop, claim cleanup

**Stack Deactivation**: Removal of one activation of a run from the session's
active-run stack without changing its claims or stash membership. _Avoid_: Run
Release, stack pop

**Terminal Evidence**: A preserved claim over a terminal run that lets its
holder resolve the run's outcome until pruning. Absorbed by the Owner Token,
which stays resolvable until pruning. _Avoid_: Terminal tombstone, retained
claim
