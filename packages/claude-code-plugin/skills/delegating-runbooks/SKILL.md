---
name: delegating-runbooks
description: Use when a rundown step_entered event lists delegated `children` with Claim Tickets (rdt_…), when orchestrating sub-agents for `- DELEGATE` substeps, when collecting delegated results with `rundown collect`, or when a ticket or a child's token was lost (`rundown retry`, `rundown release`).
---

# Delegating Runbooks

A runbook-list substep marked `- DELEGATE` runs as a **Delegation**: a child run
owned by whichever agent claims it. You, the orchestrator, keep the parent's
Owner Token, hand each child's Claim Ticket to one sub-agent, and apply the
results with `rundown collect`. The child never writes its parent.

Inline children (a runbook-list substep without `- DELEGATE`) are not
delegations: you drive them with your own Owner Token. See
[Composed Runbooks](../running-runbooks/SKILL.md#composed-runbooks).

## When to Use

- A `step_entered` event carries
  `children: [{ step, index?, runId, runbook, ticket }]`
- You are orchestrating a runbook whose steps fan out with `- DELEGATE`
- You need to apply delegated results (`rundown collect`) or understand a
  delegation refusal
- A ticket was lost, a child was never claimed, or a sub-agent cannot finish its
  child (`rundown retry`, `rundown release`)

## When NOT to Use

- You were handed a Claim Ticket and own the child — claim it and follow
  [running-runbooks](../running-runbooks/SKILL.md) (see
  [Sub-agent choreography](#sub-agent-choreography) for the two extra rules)
- Authoring runbook files — use the
  [writing-runbooks](../writing-runbooks/SKILL.md) skill

## Orchestrator Choreography

1. **Start the run** and capture `owner_token` from `runbook_started`:

   ```bash
   rundown run <runbook>
   ```

2. **Read the children.** Entering a delegated substep reserves its child and
   the child of every later delegated substep of the step. The `step_entered`
   event lists them in `children: [{ step, index?, runId, runbook, ticket }]`;
   each entry's `ticket` (`rdt_…`, a Claim Ticket) is printed **only on the
   event that issued it** — never in `rundown status`, never again. A later
   `step_entered` for the same entry (the cursor moving to the next delegated
   substep) lists the same children without tickets; they are not new work.

3. **Dispatch one sub-agent per ticket**, in parallel. Put the ticket in the
   prompt as one marker line, `RD_CLAIM_TICKET=rdt_…`, copied verbatim:

   ```text
   Agent(
     description="1.2 review-file",
     prompt="""
   Review the plan as the delegated review-file runbook directs.
   Skill(skill: "rundown:running-runbooks")
   RD_CLAIM_TICKET=rdt_…
   """
   )
   ```

   The plugin's dispatch hook sees the marker and appends the claim instructions
   to the sub-agent's prompt: claim once with `rundown claim <ticket>`, drive
   the child with its own `owner_token`, stop it on `DELEGATION_CANCELLED` or
   `PARENT_RUN_FINISHED`, release it if the token is lost. One ticket per
   dispatch, on a line of its own exactly as shown: a prompt marking two
   tickets, a marker that is not a ticket, or a line naming `RD_CLAIM_TICKET` in
   any other form (inline code, trailing text) is blocked. Never claim a ticket
   yourself — the plugin denies your `rundown claim` (`CLAIM_OUTSIDE_SUBAGENT`).

   The plugin also stamps each sub-agent's own agent id on its plain
   `rundown claim` and `rundown release`, so neither you nor the sub-agent
   passes `--agent-id`; Rundown refuses a claim it did not stamp. A sub-agent
   cannot stop while its claimed child is running and your run still counts it:
   it is told to finish the child or release it first.

4. **Collect** once sub-agents report (or any time — it never blocks):

   ```bash
   rundown collect --token <owner_token>
   ```

   The `children_collected` event reports each child:

   | `status`            | Meaning                                                  |
   | ------------------- | -------------------------------------------------------- |
   | `collected`         | Terminal; this collect applied its result (`result`)     |
   | `already_collected` | An earlier collect applied it                            |
   | `pending`           | Claimed and still running — wait, then collect again     |
   | `unclaimed`         | No agent has claimed its ticket yet — check the dispatch |
   | `cancelled`         | The run no longer counts it (substep decided, step left) |

   Terminal children are applied in any order (`completed` = PASS, `stopped` or
   `abandoned` = FAIL; a released child is `abandoned`, and its
   `runbook_abandoned` event's `parent.standing` says whether your run still
   counts it). Pending and unclaimed children exit 0 with nothing applied.
   Repeat `collect` until no child is `pending` or `unclaimed`.

5. **Recover with retry.** If you lost a ticket before dispatching it, a child
   stays `unclaimed` because its sub-agent never claimed it, or a sub-agent lost
   its child's `owner_token`, cancel that child and reserve a fresh one:

   ```bash
   rundown retry --token <owner_token> --step <substep>    # plus --index in a FOR loop
   ```

   `--step` names the delegated substep (`3.1`), not only the one the run rests
   on. The `delegation_retried` event names the `cancelledRunId` and lists the
   fresh child in `children` with its new `ticket`, printed there once. Dispatch
   it as in step 3. The old ticket and the cancelled child's commands are
   refused `DELEGATION_CANCELLED`, and nothing collects the cancelled child.
   There is no re-claim and no re-reveal: a ticket is never printed twice, and
   `retry` is the only recovery.

6. **Continue.** When collect moves the cursor, the step's handlers decide (for
   example `PASS ALL CONTINUE` / `FAIL ANY STOP`) and the output continues as
   for `rundown pass`: the next `step_entered` — with fresh tickets if that step
   delegates too — or the run's terminal. Go back to step 2 with it.

Collect is the **only** way a delegated result reaches the parent. Do not
`rundown pass` a delegated substep because a sub-agent said it finished:
deciding it by hand (`rundown pass|fail --token <owner_token> --step <substep>`,
plus `--index` inside a FOR loop) cancels its child instead. Do that only on
purpose — for example, the user tells you to abandon a stuck child.

## Sub-agent Choreography

```bash
rundown claim <ticket>                          # prints the child's runbook_started
rundown pass --token <child owner_token> --step <child step>
rundown fail --token <child owner_token> --step <child step>
rundown release <child run id>                  # only when you cannot finish it
```

- `claim` prints the child's `runbook_started` with the child's **own**
  `owner_token` and `parent: { runId, step }`, then runs it like `rundown run`
  (command steps execute; a `--prompted` parent's children are prompted too).
  The token is shown once.
- Drive the child exactly like any run you own: `--step` names the child's step,
  from the child's latest `step_entered`.
- Stop at the child's terminal. You never write the parent and never collect.
- `DELEGATION_CANCELLED` or `PARENT_RUN_FINISHED` on any command means your work
  will never be collected: end the child with
  `rundown stop --token <owner_token>` (the one command it still accepts), then
  report.
- The plugin stamps your agent id on `claim` and on `release` when you run them
  as plain commands, replacing any `--agent-id` you type: release is authorized
  only for the id your claim recorded, so only you can release your child. Never
  pass it yourself, and never hide the command in a script, a variable or a
  subshell: a claim the plugin did not stamp is refused `AGENT_ID_REQUIRED`, and
  an agent id given twice `INVALID_SYNTAX`.
- You cannot stop while your child is running and its parent still counts it:
  the stop is blocked with the instruction to finish or release it, every time,
  until you do.
- If you cannot finish the child — you lost its `owner_token` — release it with
  `rundown release <child run id>`, naming the child's `runbookId` from its
  `runbook_started`. The child ends `abandoned`, with any inline child it was
  running, and its parent collects it as a FAIL while it still counts it
  (`parent.standing: current` on the `runbook_abandoned` event). Release touches
  nothing else and grants nothing else. Never run `rundown stop --run` for a
  child: it is the human-only escape hatch for a lost top-level token, refused
  without a person at a terminal, and it refuses child runs anyway.

## Fan-out and FOR Loops

- **Fan-out:** a step listing several runbooks under `- DELEGATE` reserves one
  child per substep on entry, each with its own ticket. Dispatch all of them at
  once; one collect applies every terminal child, and the step aggregates
  (`PASS ALL` / `FAIL ANY`) once all are applied.
- **FOR + DELEGATE:** each iteration's entry reserves a fresh child with its own
  ticket, listed with `index`. Dispatch and collect per iteration; the next
  iteration's `step_entered` carries the next ticket. Deciding an iteration by
  hand needs `--index`.
- **Inside an inline child:** an inline child may delegate. Its `step_entered`
  issues the tickets, and your root token's `collect` reaches it (your token
  targets the deepest running inline child).
- **Nested delegation** — a delegated child whose own steps delegate — is not
  supported. Do not author or drive one; report it to the user.

## Variables and Outputs

- A child inherits the parent's variables — including `ContextId`, so shared
  `{{ path "..." }}` locations and cross-run artifact selectors line up — and,
  inside a FOR loop, the iteration binding, **as captured when the child was
  reserved**. Each child gets its own `RunId`. `claim` takes no `--input`.
- A child's frontmatter `outputs:` flow into the parent at collect, and later
  steps (including later delegated children) see them as variables. Declare
  consumed values with `INPUTS:` / `REQUIRED:` in the consuming runbook.

See [Template Variables](../../../../CLAUDE.md#template-variables) and
[Context Passing](../../../../docs/spec/language.md#10-context-passing).

## Refusals

A refused command writes nothing.

| Code                              | Cause                                                                                        | Do                                                                                                                                                         |
| --------------------------------- | -------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `UNKNOWN_TICKET`                  | `claim` with a ticket no reservation carries (mistyped, parent pruned)                       | Copy the ticket verbatim from the `children` that issued it                                                                                                |
| `ALREADY_CLAIMED`                 | A second `claim` of the same ticket                                                          | Drive the child with the token the first claim printed; never claim twice                                                                                  |
| `DELEGATION_CANCELLED`            | The parent no longer counts the child (substep decided by hand, retried, or step re-entered) | Sub-agent: `rundown stop --token <owner_token>` on the child, then stop. Orchestrator: dispatch the fresh ticket a `retry` or re-entry issued              |
| `PARENT_RUN_FINISHED`             | The parent completed, stopped, or was pruned                                                 | Sub-agent: `rundown stop --token <owner_token>` on the child, then stop; nothing can collect it                                                            |
| `NOTHING_TO_COLLECT`              | `collect` while the run's current step delegates nothing                                     | Collect only while resting on a step whose `step_entered` listed `children`                                                                                |
| `INVALID_STEP`                    | A token naming the other run's step (child token, parent step, or reverse)                   | Use the child token for child steps and your token for parent steps                                                                                        |
| `CONCURRENT_MODIFICATION`         | Another write landed first (results applied before it stand)                                 | Re-read with `rundown status --run <run_id>`, then re-issue. If the step's tickets were never printed, `rundown collect --token <owner_token>` prints them |
| `NOTHING_TO_RETRY`                | `retry` of a substep whose child was collected or decided, or that delegates nothing         | Retry only a delegated substep of the current step that is still `pending` or `unclaimed`                                                                  |
| `CLAIM_OUTSIDE_SUBAGENT`          | Hook denial: `claim` by you, the orchestrator, which has no agent id                         | Dispatch a sub-agent whose prompt carries the ticket; never claim it yourself                                                                              |
| `AGENT_ID_REQUIRED`               | A sub-agent's `claim` the plugin did not stamp (not a plain command)                         | Run `rundown claim <ticket>` as a plain command                                                                                                            |
| `AGENT_MISMATCH`                  | `release` by another agent than the one whose claim recorded its id                          | Release only the child you claimed; the plugin stamps your own agent id                                                                                    |
| `NOT_A_DELEGATION`                | `release` of a run that is not a delegated child                                             | Name the child's `runbookId` from the `runbook_started` your `claim` printed                                                                               |
| `RUNBOOK_COMPOSITION_UNSUPPORTED` | A substep lists more than one runbook                                                        | Report to the user; each substep composes one child                                                                                                        |

A lost ticket, an unclaimed child, or a sub-agent that lost its child's
`owner_token` is recovered with `rundown retry`; a sub-agent that cannot finish
its child releases it. `rundown status --run <run_id>` shows the run's
`children` (run id, lifecycle, result) but never a ticket or token.

## Common Mistakes

| Mistake                                           | Fix                                                                                   |
| ------------------------------------------------- | ------------------------------------------------------------------------------------- |
| Dispatching a sub-agent without the ticket        | Put `RD_CLAIM_TICKET=<ticket>` on its own line in the prompt                          |
| Claiming a ticket yourself                        | Dispatch a sub-agent; the plugin refuses `claim` outside one                          |
| Passing the delegated substep yourself            | `rundown collect --token <owner_token>`; passing it cancels the child                 |
| Sub-agent passing with the orchestrator's token   | The sub-agent uses the `owner_token` its own `claim` printed                          |
| Treating `pending` / `unclaimed` as failure       | Wait for the sub-agents, then collect again                                           |
| Re-dispatching children from a re-announced entry | Only an entry that prints `ticket` issues new work                                    |
| Sub-agent continuing after `DELEGATION_CANCELLED` | `rundown stop --token <owner_token>` on the child; its result will never be collected |
| Telling the user a ticket was lost                | `rundown retry --token <owner_token> --step <substep>`, then dispatch the new ticket  |
| Sub-agent abandoning a child silently             | `rundown release <child run id>`, so collect sees a FAIL                              |

## Reference

- [Subagent delegation](../../../../docs/guides/agent-orchestration.md)
- [Delegation patterns](../../../../runbooks/delegation/)
- [Rundown specification](../../../../docs/spec/language.md)
- [CLI reference](../../../../docs/reference/cli.md)
- [Project overview and command list](../../../../CLAUDE.md)
