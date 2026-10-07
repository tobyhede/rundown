# Spec: Delegation rebuild on one writer per run

- **Date:** 2026-10-07
- **Parent:** Epic #899
- **Decision record:** [ADR 0005](../../adr/0005-one-writer-per-run.md)
- **Vocabulary:** [CONTEXT-MAP.md](../../../CONTEXT-MAP.md) § Runs and ownership. This spec uses those terms and no retired ones.

## Problem Statement

An orchestrating agent that fans a runbook step out to sub-agents cannot trust the result today. Children write into the parent's record from other processes, so the parent is a multi-writer row and every race was patched with another mechanism. Core plus CLI is 92K lines of `src`, about 20,600 of them dedicated to delegation, authority and concurrency and another 35,000 entangled with it, to serve five runbooks that fan out at most four children one level deep. Agents are confused often: they act on the wrong run, replay a token, pass without naming a step, or stop a sub-agent with a child half-finished. The current defences are spread across claims, grants, generations, tombstones, latches and retry loops that nobody can hold in their head, and the six plugin runbooks that depend on delegation have never passed end to end.

## Solution

Every run has exactly one Run Owner, proven by an Owner Token that is printed once at `rundown run` and named on every mutation. Only the owner's commands write the run. A child reports only by reaching a terminal in its own record; the parent learns it by an explicit Collect. The multi-writer machinery is deleted rather than thinned: no session stack, stash, grants, claim rotation, generation fence, supersession tombstone, compare-and-swap retry loop, compare-and-latch, report mailbox or execution-recovery state. What remains is small enough to measure against two size gates and is proven by the five delegating plugin runbooks, the one non-delegating one, and one scenario per agent-confusion mode passing end to end.

## User Stories

1. As an orchestrating agent, I want `rundown run` to print an Owner Token once, so that I hold the only authority over my run.
2. As an orchestrating agent, I want every mutating command to require `--token`, so that a run ID I copied from status cannot be used to drive a run I do not own.
3. As an orchestrating agent, I want `pass` and `fail` to require `--step`, naming the current top-level step or a substep of it, so that a command meant for another step is refused instead of applied.
4. As an orchestrating agent, I want `--index` to be required inside a FOR loop and refused outside one, so that an iteration result cannot land on the wrong iteration.
5. As an orchestrating agent, I want a step that delegates to reserve one Current Child per delegated substep on each entry and show me a Claim Ticket for each in the step-entry output, so that I can hand each ticket to one sub-agent.
6. As a sub-agent, I want `rundown claim <ticket>` to create my child run and print its Owner Token, so that I can drive the child like any run I own.
7. As a sub-agent, I want a second claim of the same ticket to be refused, so that two agents cannot work the same child.
8. As a sub-agent, I want my commands to be refused once my child is cancelled or my parent has finished, so that I stop doing work nobody will collect.
9. As an orchestrating agent, I want `rundown collect --token` to read the terminal results of my Current Children into the parent and continue the runbook, so that the parent advances only on results I asked for.
10. As an orchestrating agent, I want Collect to ignore stale children from an earlier entry into the step, so that a GOTO or RETRY re-entry cannot be satisfied by an old result.
11. As an orchestrating agent, I want Collect to report which children are still running, so that I know to wait rather than retry.
12. As an orchestrating agent, I want an inline child runbook to be driven by my own token with no second token, so that a crash before a child token is printed cannot strand it.
13. As an orchestrating agent, I want an inline child's terminal to flow into the parent in the same command, and to be collected first by my next command after a crash, so that composition never needs a manual step.
14. As an orchestrating agent, I want `rundown retry --token --step` to cancel the Current Child and reserve a fresh one with a new ticket, so that a lost ticket, an unclaimed child or a lost child token is recoverable.
15. As an orchestrating agent, I want `pass` or `fail --step` on a delegated substep to record my decision and cancel the Current Child, so that I can resolve a delegation by hand when a sub-agent cannot.
16. As a sub-agent that lost its child Owner Token, I want `rundown release <child-id>` to record my child as abandoned, so that the parent's Collect sees a definite result.
17. As a sub-agent, I want release to be refused if I am not the agent that claimed the child, so that one sub-agent cannot abandon another's work.
18. As an orchestrating agent, I want a command whose external effect started in a process that died to be reported as Interrupted and never repeated by Rundown, so that an effect does not run twice.
19. As an orchestrating agent, I want a second attempt at a step whose command is In Progress to be refused, so that my own retried command does not run the effect twice.
20. As an orchestrating agent, I want a conflicting concurrent write to my run to be refused as a usage error rather than retried, so that two of my own commands racing is visible rather than silently serialised.
21. As an operator, I want `rundown status` to list runs, their step, In Progress or Interrupted condition, and their children with results, without ever showing a token or ticket, so that reading status grants nothing.
22. As an operator, I want `rundown prune` of a running run to require its token or an interactive confirmation, so that a confused agent cannot destroy live state with a bare command.
23. As an operator, I want prune to retain a terminal child whose result its parent has not collected and report why, so that a result is never lost before the parent reads it.
24. As an operator who lost a top-level token, I want an interactive, audited `rundown stop --run <id>` as the only recovery, so that recovery exists but cannot be driven by an agent.
25. As a plugin user, I want `rundown claim` outside a sub-agent to be refused by a hook, so that the orchestrator cannot claim its own child by mistake.
26. As a plugin user, I want a sub-agent to be blocked from stopping while it holds a claimed, unfinished, current, uncancelled child, with the instruction to finish or release it, so that children are not silently orphaned.
27. As a plugin user, I want the Bash hook to stamp the sub-agent's identity onto `claim` and `release`, so that release authority is tied to the claiming agent without the agent typing anything.
28. As a runbook author, I want FOR with DELEGATE to reserve one child per iteration, so that a loop over items delegates each item in turn.
29. As a runbook author, I want the five delegating plugin runbooks and the non-delegating one to run to completion through the CLI with simulated sub-agents, so that the rebuild is proven against real runbooks.
30. As a maintainer, I want one scenario per agent-confusion mode, so that each defence is pinned by a test that fails when it is removed.
31. As a maintainer, I want the delegation, authority and concurrency source measured against the 6,400-line gate and the touched general machinery against the 8,600-line gate, so that growth triggers a design review instead of a higher limit.
32. As a maintainer, I want the `INVALID_STEP` reference row and the running-runbooks and delegating-runbooks skills to describe the new protocol, so that agents following docs issue correct commands.
33. As an MCP client, I want the mutating tools to take the Owner Token and the claim and collect tools to exist, so that the MCP front end is the same protocol as the CLI.

## Implementation Decisions

### Authority

- **Owner Token.** A full-entropy secret with a recognisable prefix, generated at run creation, printed once on the `runbook_started` event as `owner_token`, and stored only as a hash on the run row. The token is the sole lookup key for authority: a mutating command resolves `--token` to a run by hash, and a run ID authorizes nothing. The token stays resolvable until the run is pruned, so a command on a finished run is told the run finished.
- **`--token` is required on every mutating command**: `pass`, `fail`, `goto`, `stop`, `complete`, `collect`, `retry`, and `prune` of a running run. There is no default target, no session stack and no environment-variable fallback. Read-only commands (`status`, `ls`, `check`, `resolve`, `echo`, `prompt`) stay bare; `status` accepts `--run <id>` to narrow.
- **`--run <id>` on a mutating command is accepted only by the human escape hatch** (`stop`, interactive). Everywhere else it is rejected as `INVALID_SYNTAX` when combined with `--token`, and a bare `--run` mutation is refused `ACTOR_CONTEXT_REQUIRED`-style with a remedy naming `--token`.
- **Required `--step`.** `pass`/`fail` require `--step`. It must name the current top-level step or a substep of it; both forms are accepted (this reverses part of #763; the `INVALID_STEP` row changes to match). `--index` is required when the named step is inside a FOR frame and refused otherwise. `goto` keeps its positional target.
- **Inline Child authority.** An Inline Child has no token. Its row records inherited authority from its parent. Resolving a token yields the root run; the command's target is the deepest running Inline Child reached by following each run's current inline child. `--step` then names a step of that target run, so a step name that belongs to the parent while the inline child is running is `INVALID_STEP`.

### Children

- **Current Child reservation.** On every entry into a step that has delegated or inline runbook-list substeps, the machine reserves one child per such substep in the parent's own record: a preallocated child run ID, the kind (delegation or inline), the context snapshot, and for a Delegation the hash of a fresh Claim Ticket. The reservation is keyed by frame and entry counter, so each loop iteration and each GOTO or RETRY re-entry reserves afresh and earlier reservations are stale.
- **Claim Ticket.** A full-entropy secret with its own prefix, shown only in the `step_entered` event's children list and never in status. `rundown claim <ticket>` locates the reservation by ticket hash, verifies in one transaction that the reservation is still the parent's Current Child and not cancelled, inserts the child run with the preallocated ID, and prints the child's Owner Token. Because the child's ID is the reservation's ID and a primary key, a second claim is refused `ALREADY_CLAIMED` by the insert itself. There is no re-claim and no re-reveal.
- **Child linkage.** A child row records its parent run ID, parent step, frame, entry and kind. Every child command checks that it is still the parent's Current Child for that coordinate and that the parent is running; otherwise it is refused `DELEGATION_CANCELLED` or `PARENT_RUN_FINISHED`. The check may race a Cancellation; that is harmless because Collect decides.
- **Agent identity.** `claim` and `release` accept `--agent-id`. The plugin's Bash hook stamps it; a human or the scenario harness may pass it by hand. The ID recorded at claim is the only thing `release` matches against; both absent counts as a match.
- **Child Result.** A child's terminal lifecycle is its result: `completed` collects as pass, `stopped` as fail, and a new `abandoned` lifecycle (written only by `release`) as fail. Final variables stay on the child and flow to the parent at Collect as OUTPUTS do today.
- **Collect.** `rundown collect --token` reads the parent's Current Children for its active frame and entry. For each terminal child not yet applied it sends the substep's PASS or FAIL into the machine with the child's final variables, then continues Run Progression. Children still running are reported `pending`; an already-applied child is `already_collected`. Collect is the only path by which a Delegation's result reaches the parent. Nested delegation is neither refused nor supported.
- **Implicit Collect for Inline Children.** When an owner's command drives an Inline Child to a terminal, the same command collects that result into the parent and continues the parent's progression. The parent's next command after a crash collects a terminal inline child first, before doing anything else.
- **Cancellation.** The parent owner records that a Current Child no longer counts by `retry --token --step [--index]`, which cancels and reserves a fresh child with a new ticket, or by `pass`/`fail --step` on the delegated substep, which cancels and records the decision. Reaching a terminal on the parent cancels every child implicitly through the parent-running check. There is no `abort` and no `delegate` command: tickets are issued on entry and reissued by `retry`.
- **Release.** `rundown release <child-id> --agent-id` writes `abandoned` on the child's own row when the agent matches. It grants nothing else and never touches the parent.

### Execution lease

- A run row carries one lease: `{attempt, pid, start_id, started_at}`. Run Progression sets it by a conditional update immediately before an external effect (a command execution or helper invocation) and clears it when the finish commits, only if the attempt still holds. A set lease with a live owner process is In Progress and refuses a second attempt; a set lease whose owner is dead is Interrupted, reported on status and on the refusing command, and never repeated by Rundown. The owner clears it by an explicit decision (`retry` of the step via the authored RETRY, `goto`, `fail`, or `stop`). Process liveness is `(pid, start id)` as today's `process-identity` module computes it; that module survives.

### Concurrency

- Run state writes are conditional on `state_version`. A mismatch is refused `CONCURRENT_MODIFICATION` once, with no retry loop and no backoff. There are no file locks on run state. The artifact manifest lock, the sql.js driver lock and the plugin session lock stay, since each protects a file-backed artifact.
- Transactions remain synchronous (`SyncWork`), and an external effect is never run inside one.

### Storage

- A new SQLite schema version with two tables: `runs` and nothing else for authority. `runs` carries id, lifecycle (running, completed, stopped, abandoned), owner token hash, parent linkage columns, lease columns, state_version, state_json and timestamps. The tables `claims`, `session_stack`, `stash_slot`, `resolved_completions` and `execution_attempts` are dropped. `RunbookState` loses `resolvedCompletions`, the delegation credential descriptors, and the inline launch latch; it gains the reservation records on substep states. `CURRENT_SCHEMA_VERSION` moves. Nothing is migrated.
- A ticket is located by scanning the running runs' reservations for its hash. At this project's scale that is a handful of rows; an index table is a later decision if measurement shows the need.

### Plugin

- A `PreToolUse` hook on `Bash` recognises `rundown claim` and `rundown release` invocations, refuses `claim` when the hook input carries no `agent_id`, and otherwise rewrites the command to carry `--agent-id <agent_id>`.
- The `SubagentStop` hook reads the stopping agent's claimed children from the store (children whose recorded agent ID matches), and blocks with the finish-or-release instruction while any is running, current and uncancelled. It keeps no counter.
- The `PreToolUse` hook on `Agent`/`Task` keeps detecting a ticket marker in the prompt and injecting the claim instructions, rewritten for tickets and `--token`.
- The `running-runbooks` and `delegating-runbooks` skills are rewritten for the protocol: capture `owner_token`, pass `--token` and `--step` on every mutation, hand tickets to sub-agents, `collect`, `retry`, `release`.

### Deletions

Everything in groups A to F of the code map is removed together with its tests: claims and grants, run-control claims, the command target resolver and issuance anchor, delegation exposure, the subprocess mutation boundary, delegation tokens and credential derivers, the delegation scan service, the manual delegation machine, the retry hook's delegation arms, collection and completion mailbox services, inline parent advance, session service, session release and reader, stash and pop, the execution lease service's attempts and recovery, the effectful mutation executor and runner, the re-entry frontier projection, the inline launch latch, fence and intent actors, and the `delegate`, `claim` (old), `collect` (old), `abort`, `stash` and `pop` commands. The compiler, run progression, actor service, state manager, store, lifecycle command service and targeting module are reduced to what the new model needs. MCP tool definitions follow the CLI.

### Documentation

- `docs/reference/cli.md`, `docs/spec/cli-output.md`, `docs/reference/runtime.md`, `docs/internal/concurrency.md`, `docs/internal/architecture.md` and `docs/guides/agent-orchestration.md` are rewritten to describe the built model; retired sections are deleted, not annotated. ADR 0005's status moves to Accepted (built) when the epic closes.

## Testing Decisions

A good test here drives a public seam and asserts the observable result: a JSON envelope, an event, a refusal code, a row in status. It does not reach into the store, mock a collaborator inside core, or assert on an internal field name.

Seams, highest first:

1. **Scenario harness** (`rundown scenario run`, `scenario-suite run`). The primary acceptance seam for every behaviour an agent would see. Fixtures capture `${TOKEN}` from `runbook_started.owner_token`, `${TICKET}`/`${TICKET_2}` from `step_entered`, `${CHILD_TOKEN}` and `${CHILD_RUN}` from `claim`. The harness grows a `--agent-id` passthrough so confusion modes involving identity can be scripted. Prior art: `runbooks/scenario-suite.yaml`, `runbooks/delegation/*.runbook.md`.
2. **CLI command tests through the in-process runner**, for refusal envelopes, exit codes, schema compliance and the escape hatch's interactive prompt. Prior art: `packages/cli/__tests__/commands/*.test.ts`.
3. **Core seam tests** for the store (token lookup, conditional lease update, conflicting write refusal, `abandoned`), the lifecycle command seam (`--step` acceptance, inline descent targeting), the child service (claim transaction, release match) and Collect. Prior art: `packages/core/__tests__/runbook/storage/*.test.ts`, `lifecycle-command-service*.test.ts`.
4. **Plugin hook tests** with structural doubles for the store and hook input. Prior art: `packages/claude-code-plugin/__tests__/hooks/*.test.ts`.
5. **Runbook end-to-end** via the plugin scenario suite and the plugin runtime integration tests, driving each of the six runbooks to COMPLETE with simulated sub-agents, plus one multi-process test that observes a genuine In Progress refusal.

Mutation testing with `pnpm run test:mutate:changed` on each slice; `pnpm run verify` before every push.

## Out of Scope

- Nested delegation (a Delegation that itself delegates). Neither refused nor supported.
- Nested FOR.
- Any migration or compatibility path for persisted state or the old CLI flags.
- A ticket index table, a daemon, or any new lock or retry loop for run state.
- Re-claim, re-reveal, or recovering a lost top-level token by anything but the human escape hatch.
- The `site/` WebContainer demo beyond keeping it compiling on the sql.js driver.

## Further Notes

- The epic's "six runbooks" are five delegating ones plus `meta/convert-skill`, which does not delegate. It stays in the acceptance set as the non-delegating control.
- Fan-out width is authored: review-plan step 3 fans out to four. FOR plus DELEGATE repeats width one serially with `--index`.
- The sequence is demolish first, then rebuild in vertical slices, because the old invariants live inside the store's commit path and the compiler's frontier states; building beside them would double the machinery the gates exist to shrink. The branch is red between the demolition slice and its green, and green at every ticket boundary after that.
- Size is measured by `wc -l` over an explicit allow-list of files committed with the measurement script, so the gate is reproducible rather than argued.
