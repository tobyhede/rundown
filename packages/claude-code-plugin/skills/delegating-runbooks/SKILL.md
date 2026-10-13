---
name: delegating-runbooks
description: Use when a rundown step_entered event lists delegated `children` with Claim Tickets (rdt_…), when orchestrating sub-agents for `- DELEGATE` substeps, or when collecting delegated results with `rundown collect`.
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

- A `step_entered` event carries `children: [{ step, index?, runId, runbook, ticket }]`
- You are orchestrating a runbook whose steps fan out with `- DELEGATE`
- You need to apply delegated results (`rundown collect`) or understand a
  delegation refusal

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
   each entry's `ticket` (`rdt_…`, a Claim Ticket) is printed
   **only on the event that issued it** — never in `rundown status`, never
   again. A later `step_entered` for the same entry (the cursor moving to the
   next delegated substep) lists the same children without tickets; they are
   not new work.

3. **Dispatch one sub-agent per ticket**, in parallel. The plugin does not
   inject claim instructions (its hooks are inert in this build), so the prompt
   must carry the ticket and the claim command itself:

   ```text
   Agent(
     description="1.2 review-file",
     prompt="""
   You own one delegated Rundown child run.
   1. Skill(skill: "rundown:running-runbooks")
   2. Run exactly once: rundown claim rdt_… --agent-id reviewer-1.2
   3. Capture owner_token from the runbook_started event it prints. That is
      your token; drive the child with
      rundown pass|fail --token <that owner_token> --step <child step>
      following each step_entered prompt.
   4. Stop when the child reports runbook_completed or runbook_stopped. If any
      command is refused DELEGATION_CANCELLED or PARENT_RUN_FINISHED, end the
      child with rundown stop --token <that owner_token> and stop. Report the
      outcome. Never run rundown collect and never use any other token.
   """
   )
   ```

   `--agent-id` is optional; it records the claiming agent on the child.

4. **Collect** once sub-agents report (or any time — it never blocks):

   ```bash
   rundown collect --token <owner_token>
   ```

   The `children_collected` event reports each child:

   | `status`            | Meaning                                                     |
   | ------------------- | ----------------------------------------------------------- |
   | `collected`         | Terminal; this collect applied its result (`result`)        |
   | `already_collected` | An earlier collect applied it                               |
   | `pending`           | Claimed and still running — wait, then collect again        |
   | `unclaimed`         | No agent has claimed its ticket yet — check the dispatch    |
   | `cancelled`         | The run no longer counts it (substep decided, step left)    |

   Terminal children are applied in any order (`completed` = PASS, `stopped`
   or `abandoned` = FAIL). Pending and unclaimed children exit 0 with nothing
   applied. Repeat `collect` until no child is `pending` or `unclaimed`.

5. **Continue.** When collect moves the cursor, the step's handlers decide (for
   example `PASS ALL CONTINUE` / `FAIL ANY STOP`) and the output continues as
   for `rundown pass`: the next `step_entered` — with fresh tickets if that
   step delegates too — or the run's terminal. Go back to step 2 with it.

Collect is the **only** way a delegated result reaches the parent. Do not
`rundown pass` a delegated substep because a sub-agent said it finished:
deciding it by hand (`rundown pass|fail --token <owner_token> --step <substep>`,
plus `--index` inside a FOR loop) cancels its child instead. Do that only on
purpose — for example, the user tells you to abandon a stuck child.

## Sub-agent Choreography

```bash
rundown claim <ticket> --agent-id <id>          # prints the child's runbook_started
rundown pass --token <child owner_token> --step <child step>
rundown fail --token <child owner_token> --step <child step>
```

- `claim` prints the child's `runbook_started` with the child's **own**
  `owner_token` and `parent: { runId, step }`, then runs it like `rundown run`
  (command steps execute; a `--prompted` parent's children are prompted too).
  The token is shown once.
- Drive the child exactly like any run you own: `--step` names the child's
  step, from the child's latest `step_entered`.
- Stop at the child's terminal. You never write the parent and never collect.
- `DELEGATION_CANCELLED` or `PARENT_RUN_FINISHED` on any command means your
  work will never be collected: end the child with
  `rundown stop --token <owner_token>` (the one command it still accepts), then
  report.

## Fan-out and FOR Loops

- **Fan-out:** a step listing several runbooks under `- DELEGATE` reserves one
  child per substep on entry, each with its own ticket. Dispatch all of them at
  once; one collect applies every terminal child, and the step aggregates
  (`PASS ALL` / `FAIL ANY`) once all are applied.
- **FOR + DELEGATE:** each iteration's entry reserves a fresh child with its
  own ticket, listed with `index`. Dispatch and collect per iteration; the next
  iteration's `step_entered` carries the next ticket. Deciding an iteration by
  hand needs `--index`.
- **Nested:** an inline child may itself delegate. Its `step_entered` issues the
  tickets, and your root token's `collect` reaches it (your token targets the
  deepest running inline child).

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

| Code                              | Cause                                                                      | Do                                                                                     |
| --------------------------------- | -------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| `UNKNOWN_TICKET`                  | `claim` with a ticket no reservation carries (mistyped, parent pruned)     | Copy the ticket verbatim from the `children` that issued it                            |
| `ALREADY_CLAIMED`                 | A second `claim` of the same ticket                                        | Drive the child with the token the first claim printed; never claim twice              |
| `DELEGATION_CANCELLED`            | The parent no longer counts the child (substep decided by hand, step re-entered) | Sub-agent: `rundown stop --token <owner_token>` on the child, then stop. Orchestrator: dispatch the fresh ticket, if a re-entry issued one |
| `PARENT_RUN_FINISHED`             | The parent completed, stopped, or was pruned                               | Sub-agent: `rundown stop --token <owner_token>` on the child, then stop; nothing can collect it |
| `NOTHING_TO_COLLECT`              | `collect` while the run's current step delegates nothing                   | Collect only while resting on a step whose `step_entered` listed `children`            |
| `INVALID_STEP`                    | A token naming the other run's step (child token, parent step, or reverse) | Use the child token for child steps and your token for parent steps                    |
| `CONCURRENT_MODIFICATION`         | Another write landed first (results applied before it stand)               | Re-read with `rundown status --run <run_id>`, then re-issue. If the step's tickets were never printed, `rundown collect --token <owner_token>` prints them |
| `RUNBOOK_COMPOSITION_UNSUPPORTED` | A substep lists more than one runbook                                      | Report to the user; each substep composes one child                                    |

A lost ticket, or a sub-agent that lost its child's `owner_token`, has no agent
recovery in this build: tell the user. `rundown status --run <run_id>` shows the
run's `children` (run id, lifecycle, result) but never a ticket or token.

## Common Mistakes

| Mistake                                              | Fix                                                                      |
| ---------------------------------------------------- | ------------------------------------------------------------------------ |
| Dispatching a sub-agent without the ticket           | Put the ticket and the `rundown claim` command in its prompt             |
| Passing the delegated substep yourself               | `rundown collect --token <owner_token>`; passing it cancels the child    |
| Sub-agent passing with the orchestrator's token      | The sub-agent uses the `owner_token` its own `claim` printed             |
| Treating `pending` / `unclaimed` as failure          | Wait for the sub-agents, then collect again                              |
| Re-dispatching children from a re-announced entry    | Only an entry that prints `ticket` issues new work                       |
| Sub-agent continuing after `DELEGATION_CANCELLED`    | `rundown stop --token <owner_token>` on the child; its result will never be collected |

## Reference

- [Subagent delegation](../../../../docs/guides/agent-orchestration.md)
- [Delegation patterns](../../../../runbooks/delegation/)
- [Rundown specification](../../../../docs/spec/language.md)
- [CLI reference](../../../../docs/reference/cli.md)
- [Project overview and command list](../../../../CLAUDE.md)
