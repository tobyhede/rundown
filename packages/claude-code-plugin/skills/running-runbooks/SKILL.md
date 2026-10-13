---
name: running-runbooks
description: Use when stepping through a Rundown runbook that is already active or has just been started, when handed a Rundown Claim Ticket (rdt_…) to claim and drive a delegated child run, or when rundown CLI commands appear in step output. For cold-start "run the X runbook" requests with nothing active, the rundown launcher skill starts the runbook first.
---

# Running Runbooks

Rundown executes markdown runbooks step by step. The CLI owns progress: you act
on each step's output, report the result, and the CLI decides what comes next.

## When to Use

- A Rundown runbook has just been started or is active and needs step-by-step
  execution
- CLI output from `rundown` asks for a pass/fail response or names a step
  position
- A prompt or command output references Rundown step IDs, substeps, or FOR loop
  indexes

## When NOT to Use

- Writing or editing runbook files — use the writing-runbooks skill instead
- Planning work before authoring a runbook — use the writing-plans skill when
  applicable
- Running unrelated shell commands that are not part of a Rundown-controlled
  workflow

## The Owner Token

`rundown run` prints the run's **owner token** (`rdo_…`) exactly once, as
`owner_token` on the first event, `runbook_started`. Keep it verbatim for the
whole run: every mutating command (`pass`, `fail`, `goto`, `stop`, `complete`)
takes `--token <owner_token>`, and the token is your only authority to change
the run.

No other command, status response, or listing ever shows it again, and it cannot
be recovered. If you lose it, you can still read the run but no longer drive it:
tell the user.

The same event carries the **run id** (`runbookId`, `rd_…`). The run id is for
reading only — `rundown status --run <run_id>`. Mutating commands take `--token`
alone; adding `--run` to them is refused `INVALID_SYNTAX`.

## The Loop

1. **Start** the runbook and capture `owner_token` and `runbookId` from
   `runbook_started`:

   ```bash
   rundown run <runbook>
   ```

   Command steps run automatically. The output stops at the first step that
   needs you — its last event is `step_entered` with a `prompt` — or at the end
   of the run.

2. **Read the position** from the latest `step_entered` event's `position` and
   turn it into flags:

   | `position`                                                | Flags                  |
   | --------------------------------------------------------- | ---------------------- |
   | `{"current":"2"}`                                         | `--step 2`             |
   | `{"current":"2","substep":"1"}`                           | `--step 2.1`           |
   | `{"current":"2","substep":"1","for":{"index":3,"end":5}}` | `--step 2.1 --index 3` |

   `--step` and `--index` confirm the position you are reporting on; they never
   select a different step.

3. **Do the step.** Follow the `prompt` exactly.

4. **Report the result:**

   ```bash
   rundown pass --token <owner_token> --step 2.1 --index 3   # step done as written
   rundown fail --token <owner_token> --step 2.1 --index 3   # step cannot be done as written
   ```

   The output is the next set of events. Return to step 2 with the newest
   `step_entered`.

5. **Finish** when the output reports the run's end: a `runbook_completed` or
   `runbook_stopped` event, or an action with `"complete": true` or
   `"stopped": true`. Every step is done when the run says so, not before.

If you lose track of the position, `rundown status --run <run_id>` shows it in
the same `position` shape.

## Transitions

Default transitions: **PASS** advances to the next step; **FAIL** stops the run.
The runbook may override these (retry, `GOTO` another step, continue past a
failure). **Trust Rundown for execution state and transitions** — what it
reports is correct, even when the result seems unexpected. Still apply normal
safety, permission, and policy checks before running commands or taking external
actions.

Exit codes answer one question: has the run halted? Non-zero means the run
stopped or the command was refused. Zero means the run is still progressing or
completed — including after a `rundown fail` whose handler absorbed the failure.
Read the JSON for what happened.

## Other Commands

```bash
rundown goto <step> --token <owner_token>            # Jump to a step (e.g. 3 or 3.1; --index for a FOR iteration)
rundown stop [message] --token <owner_token>         # Abort the run
rundown complete [message] --token <owner_token>     # Force early completion

rundown status                    # List every run (read-only)
rundown status --run <run_id>     # One run in detail, including its position
rundown ls --all                  # List available runbooks
```

Use `goto`, `stop`, and `complete` only when a step's instructions or the user
call for them.

## Inputs

If `rundown run` reports missing required inputs (`MISSING_REQUIRED_VARS`),
supply them and start again:

```bash
rundown run <runbook> --input key=value
rundown run <runbook> --input-json key=json
rundown run <runbook> --input-file <path>
```

Outputs declared by steps become available to later steps automatically. When a
later step references `{{ PlanPath }}`, trust that Rundown carried the value
forward; copy values by hand only when a step tells you to.

## Composed Runbooks

A substep that lists one other runbook (and is not `- DELEGATE`) runs it as an
**inline child**: a separate run you drive with your own Owner Token. There is
no second token — the child's `runbook_started` event carries no `owner_token`.

- While an inline child runs, every `pass` / `fail` / `goto` / `stop` /
  `complete` with your token acts on that child (the deepest one, when children
  nest), and `--step` names the **child's** step — take it from the child's
  latest `step_entered` (its `runbookId` is the child's). Naming the parent's
  step is refused `INVALID_STEP`, and the message names the child.
- When the child finishes, the same command feeds its result (completed = pass,
  stopped = fail) and its outputs into the parent and the parent carries on.
  Keep following the latest `step_entered`, whichever run it belongs to. Do not
  stop the parent yourself because a child stopped: the parent's own handlers
  decide.
- `rundown status` shows the chain: each child carries `parent`, and
  `rundown status --run <parent_run_id>` shows its current `child`.
- An inline child that cannot start (missing runbook, missing required input)
  leaves the parent waiting on that substep; report it to the user, or decide
  the substep with `rundown fail --token <owner_token> --step <parent substep>`.

A substep marked `- DELEGATE` is a **delegation**: a child run owned by the
agent that claims it. Its `step_entered` lists `children` with Claim Tickets
(`rdt_…`). As the orchestrator, follow the
[delegating-runbooks](../delegating-runbooks/SKILL.md) skill: hand each ticket
to a sub-agent, then apply the results with
`rundown collect --token <owner_token>` — never `pass` the delegated substep
yourself.

## Claimed Delegations

If you were handed a Claim Ticket, you own that child run:

```bash
rundown claim <ticket> --agent-id <id>    # --agent-id is optional
```

`claim` prints the child's `runbook_started` with the child's **own**
`owner_token`; use it as `<owner_token>` in the loop above, and `--step` names
the child's steps. Two extra rules:

- Stop at the child's terminal. You never write or collect the parent; its
  owner collects your result.
- `DELEGATION_CANCELLED` or `PARENT_RUN_FINISHED` on any command means your
  work will never be collected: stop and report.

## Refusals

A refused command writes nothing. Fix the cause and re-issue it.

| Code                              | Cause                                                                                        | Fix                                                                        |
| --------------------------------- | -------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| `TOKEN_REQUIRED`                  | Mutating command without `--token`                                                           | Add `--token <owner_token>`                                                |
| `UNKNOWN_TOKEN`                   | No run carries that token (mistyped, or the run was pruned)                                  | Copy `owner_token` verbatim from `runbook_started`; if lost, tell the user |
| `INVALID_STEP`                    | `--step` / `--index` missing or not the current position (an inline child's, while one runs) | The message names the current position; re-issue with it                   |
| `INVALID_SYNTAX`                  | `--run` combined with `--token`, among other syntax errors                                   | Drop `--run` from mutating commands                                        |
| `RD-303` / `RD-304`               | The run already completed / stopped                                                          | Nothing to drive; report the outcome                                       |
| `CONCURRENT_MODIFICATION`         | Another write landed on the run first                                                        | Re-read with `rundown status --run <run_id>`, then re-issue                |
| `RUNBOOK_COMPOSITION_UNSUPPORTED` | A substep lists more than one runbook | Report it to the user and stop |
| `NOTHING_TO_COLLECT` | `collect` while the current step delegates nothing | Collect only after a `step_entered` that listed `children` |
| `UNKNOWN_TICKET` / `ALREADY_CLAIMED` | `claim` with an unknown ticket / a ticket already claimed | Copy the ticket verbatim; claim once and keep its `owner_token` |
| `DELEGATION_CANCELLED` / `PARENT_RUN_FINISHED` | Your delegated child no longer counts / its parent finished | Stop working on the child and report |

A `policy_denied` event means the security policy refused a command step and the
run stopped. Report it to the user; permission is theirs to grant (see the
[security reference](../../../../docs/reference/security.md)).

## Structured Output

JSON is the agent-facing output format — every command emits machine-readable
JSON by default. The `--text` flag exists only for humans reading output in a
terminal; it is not part of the agent protocol. **Do not add `--text`** to any
command — parse the JSON instead.

## Rules

- **Follow all step instructions exactly** — do not skip, improvise, or
  reinterpret
- **Never work around transitions** — if a FAIL handler retries or GOTOs, that
  is correct behavior
- **Complete ALL steps** — drive the run until it reports completed or stopped
- **Use the CLI** — every step ends with `rundown pass` or `rundown fail`, not a
  verbal acknowledgment

## Common Mistakes

| Mistake                                     | Fix                                                                      |
| ------------------------------------------- | ------------------------------------------------------------------------ |
| Verbal "done" instead of CLI                | `rundown pass --token <owner_token> --step <position>`                   |
| Not saving `owner_token` from `rundown run` | Capture it from `runbook_started` before doing anything else             |
| `--step 2` while substep 2.1 is current     | Report the substep: `--step 2.1`                                         |
| Missing `--index` inside a FOR iteration    | Add `--index <position.for.index>`                                       |
| Abandoning a run mid-way                    | Complete all steps, or `rundown stop --token <owner_token>` deliberately |

## Prompted Mode

> Included for completeness. **Automatic execution is the default and the
> typical usage** — reach for `--prompted` only when you explicitly need to step
> through manually.

`rundown run <runbook> --prompted` shows command steps without executing them:
run the command yourself, then report with `rundown pass` / `rundown fail` (with
`--token` and `--step`). `rundown run <runbook> --prompted --step <n>` jumps to
a step after starting; `--step` on `run` requires `--prompted`.

## Reference

- [CLI reference](../../../../docs/reference/cli.md)
- [CLI JSON output spec](../../../../docs/spec/cli-output.md)
- [Rundown specification](../../../../docs/spec/language.md)
- [Runbook patterns and examples](../../../../runbooks/README.md)
