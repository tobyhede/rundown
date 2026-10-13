# Driving a Run from an Agent

How an agent drives a Rundown run today: start it, keep its Owner Token, report
each step's result against the run's current position, and hand delegated steps
to subagents by Claim Ticket.

**Related docs:**

- [docs/reference/cli.md](../reference/cli.md) — CLI command reference,
  including [Run Ownership](../reference/cli.md#run-ownership)
- [docs/spec/cli-output.md](../spec/cli-output.md) — JSON output and error codes
- [docs/reference/runtime.md](../reference/runtime.md) — Execution model, state,
  variables
- [docs/spec/language.md](../spec/language.md) — Rundown format specification
  (steps, substeps, transitions)

---

## One run, one owner

Every run has exactly one owner, proven by its **Owner Token**. `rundown run`
prints the token once, as `owner_token` on the `runbook_started` event, and no
later command or status response shows it again. The agent that starts a run
keeps the token and passes it as `--token` on every command that changes the
run: `pass`, `fail`, `goto`, `stop`, and `complete`.

```bash
rundown run --prompted deploy.runbook.md
# {"type":"runbook_started", ..., "owner_token":"rdo_...", "runbookId":"rd_...", ...}
# {"type":"step_entered","position":{"current":"1","total":3}, ...}
```

The run id (`runbookId`, `rd_…`) is not authority. It selects a run for
read-only commands such as `rundown status --run <run_id>`, and nothing else.

## Reporting results

`pass` and `fail` confirm the position being reported on: `--step` names the
run's current step or substep, and `--index` names the current iteration inside
a FOR loop.

```bash
rundown pass --token "$OWNER_TOKEN" --step 1
rundown fail --token "$OWNER_TOKEN" --step 2.1
rundown pass --token "$OWNER_TOKEN" --step 3.1 --index 2
```

A position other than the current one is refused `INVALID_STEP` before anything
is written, and the message names the current position. `goto`, `stop`, and
`complete` take `--token` and no `--step`.

## Concurrent commands

Each mutating command reads the run, derives its change, and commits it with a
single conditional write. If another command wrote the run in between, the later
one is refused `CONCURRENT_MODIFICATION` and writes nothing; it is never retried
for you. Drive a run from one place at a time: re-read the run with
`rundown status --run <run_id>` and re-issue the command if you see this
refusal.

## Composed runbooks

A substep that lists one other runbook, without `DELEGATE`, runs it as an
**Inline Child**: a child run you drive with your own Owner Token. While it
runs, every mutating command with your token acts on the deepest running inline
child and `--step` names that child's step; when the child finishes, the same
command feeds its result and outputs into the parent substep and the parent
continues. `rundown status` shows the chain through each child's `parent`. See
[docs/reference/cli.md § Composition](../reference/cli.md#composition).

## Delegating to subagents

A substep marked `DELEGATE` runs as a **Delegation**: a child run owned by the
subagent that claims it.

1. Entering the step lists each child on `step_entered`:
   `children: [{ step, runId, runbook, ticket }]`. The `ticket` (`rdt_…`) is a
   Claim Ticket, printed only there, once.
2. Dispatch one subagent per child, with its ticket in the prompt on a line of
   its own: `RD_CLAIM_TICKET=<ticket>`. In Claude Code the plugin sees the
   marker and appends the claim instructions to the subagent's prompt; on a host
   without the plugin's hooks, put the instruction to run
   `rundown claim <ticket>` in the prompt yourself. The claim prints the child's
   own `owner_token`; the subagent drives the child with it like any run it
   owns, and stops at the child's terminal.
3. Apply the results with `rundown collect --token <owner_token>`. Collect
   reports each child (`collected`, `pending`, `unclaimed`, …) and applies every
   terminal one, in any order; when the step's children are all applied the run
   continues. Repeat it while children are pending.

4. Recover with `rundown retry --token <owner_token> --step <substep>` (plus
   `--index` in a FOR loop) when a ticket was lost, a child stays `unclaimed`,
   or a subagent lost its child's `owner_token`. Retry cancels that child and
   reserves a fresh one; its `delegation_retried` event prints the new ticket
   once. Dispatch it as in step 2. There is no re-claim and no re-reveal: a
   ticket is printed once, and a child is claimed once.

A subagent whose child the parent no longer counts — you decided the substep by
hand, retried it, or the step was entered again — is refused
`DELEGATION_CANCELLED`, and `PARENT_RUN_FINISHED` once the parent finished or
was pruned; either means stop, and end the child with
`rundown stop --token <child owner_token>`, the one command it still accepts. A
subagent that cannot finish its child — it lost the child's `owner_token` — runs
`rundown release <child run id>`, authorized by the agent id its claim recorded:
the child ends `abandoned` (with any Inline Child it was running), and your
collect applies it as a FAIL while your run still counts it; the
`runbook_abandoned` event's `parent.standing` says whether it does. Release
grants nothing else and never touches your run. See
[docs/reference/cli.md § Delegation](../reference/cli.md#delegation).

Your own top-level `owner_token` has no agent recovery. If you lose it, ask the
user: only a person at an interactive terminal can stop the run, with the
audited escape hatch `rundown stop --run <run-id>`
([docs/reference/cli.md](../reference/cli.md#escape-hatch)). Never run it
yourself; it is refused `INTERACTIVE_REQUIRED` without a terminal.

A finished child whose result you have not collected is kept by `rundown prune`,
`--all` included, until you collect it, retry it, or your run finishes or is
pruned ([Child Result retention](../reference/cli.md#prune-retention)).

### Agent identity and the Claude Code plugin hooks

`claim` records the claiming agent's id (`--agent-id`), and `release` is
authorized only for that id. In Claude Code the plugin supplies it:

- Its `PreToolUse` hook on `Bash` stamps the subagent's own `agent_id` on every
  `rundown claim` and `rundown release`, replacing any `--agent-id` typed, so no
  agent passes it and none can claim or release under another's id. A `claim`
  from the top-level agent (no `agent_id`) is refused: the orchestrator never
  claims its own children. A top-level `release` carries no agent id, so it
  releases only a child claimed without one.
- Its `SubagentStop` hook blocks a subagent from stopping while a child it
  claimed is running and your run still counts it, telling it to finish the
  child or release it; it allows the stop once the child is finished, abandoned
  or cancelled. The question is core's, asked through
  `rundown status --claimed-by <agent_id>`.

Without those hooks — the Codex plugin, a person, the scenario harness — the
claimant passes one stable id of its own by hand, the same on `claim` and
`release`, and nothing holds its stop. See
[docs/internal/plugin-trust-model.md](../internal/plugin-trust-model.md).

---

## Aggregate Transitions

A step's substeps report individually; aggregate conditions decide the step's
transition from their results:

```markdown
## 2. Review
- PASS ALL CONTINUE
- FAIL ANY GOTO 4

### 2.1 First reviewer
### 2.2 Second reviewer
```

| Condition       | Meaning                                            |
| --------------- | -------------------------------------------------- |
| `PASS ALL`      | All substeps passed (pair with `FAIL ANY`)         |
| `FAIL ANY`      | At least one substep failed (pair with `PASS ALL`) |
| `PASS ANY`      | At least one substep passed (pair with `FAIL ALL`) |
| `FAIL ALL`      | All substeps failed (pair with `PASS ANY`)         |
| `PASS` / `FAIL` | Standard single-result transitions                 |

See [docs/spec/language.md](../spec/language.md) for the full transition
grammar.
