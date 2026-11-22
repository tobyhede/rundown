# Driving a Run from an Agent

How an agent drives a Rundown run today: start it, keep its Owner Token, and
report each step's result against the run's current position. Subagent
delegation returns in #904.

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

A runbook whose substeps compose other runbooks — a runbook list or a `DELEGATE`
annotation — is refused at `rundown run` with `RUNBOOK_COMPOSITION_UNSUPPORTED`,
before any run is created. The error names the composing substeps. Inline
composition returns in #903 and subagent delegation in #904.

The Claude Code plugin's `PreToolUse` (`Agent|Task`) and `SubagentStop` hooks
are registered but currently allow every call without injecting context; see
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
