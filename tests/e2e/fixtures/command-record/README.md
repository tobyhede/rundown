# Command record fixture runs

Two container runs with a real agent, kept to show what the command record
holds. The command record is the file the E2E container's recorder writes, one
JSON line per `rundown` or `rd` call (see
[ADR 0007](../../../../docs/adr/0007-observed-agent-runs-are-the-primary-oracle.md)
and `scripts/e2e-command-recorder.mjs`).

- `write-plan-run` is a real runbook run. It is the run issue #949 asks for.
- `sub-agent-check` is not a runbook run. It checks one mechanism: a sub-agent's
  `rundown` call reaches the recorder.

Both were made on 2026-11-23 in the E2E image, on a Linux arm64 VM with Landlock
turned on. The agent was Claude Code 2.1.330 with the model `claude-opus-5-5`.
The image installs the newest Claude Code when it is built, so the harness does
not pin the agent version.

## Files

Each run has two files:

- `command-record.jsonl` is the command record, as the container wrote it.
- `transcript-commands.jsonl` lists every Bash tool call in the agent's
  transcript whose command names `rundown` or `rd`. `source` says whether the
  main agent or a sub-agent made the call. The raw transcript is not kept here.

The records are not redacted. They hold the Owner Tokens of runs that lived only
in a container that no longer exists.

## What was compared

For each line of `transcript-commands.jsonl`, the record must hold an entry with
the same arguments, started within a second of the tool call. An entry the
transcript does not show is allowed. A transcript command with no entry is a
failure.

The comparison reads Bash tool calls only. It would not see a `rundown` call
that an agent made by another route.

## `write-plan-run`

The harness, `pnpm run test:e2e`, with this prompt and nothing else:

> Write an implementation plan for this task: Add a health check endpoint at GET
> /health that returns JSON with status and database connectivity

The agent loaded the `writing-plans` skill, then the `running-runbooks` skill,
and ran `planning/write-plan.runbook.md` from step 1 to step 10. The harness's
`rd status` after the agent ended reports the run as `complete`.

| Transcript command (source)                                       | Record entry                                     |
| ----------------------------------------------------------------- | ------------------------------------------------ |
| `rundown run rundown:write-plan` (main)                           | same arguments, top-level, exit 0                |
| `rundown pass --token … --step N` for N = 1 to 8, one each (main) | same arguments, top-level, exit 0, eight entries |
| `git checkout … && rundown pass --token … --step 10` (main)       | `rundown pass --token … --step 10`, top-level, 0 |

The transcript holds 10 commands and the record holds an entry for each. The
largest gap between a tool call and its entry's start is 0.63 seconds.

The record holds four more entries, all made by the harness and not by the
agent: the Landlock check (`rd run check.runbook.md --yes`), the recorder check
(`rd run recorder-check.runbook.md --yes`, with the step's `rundown --version`
as a nested entry), and the `rd status` after the agent ended.

There is no `pass` for step 9. Step 9 is a command step, so rundown ran it
inside the `pass --step 8` call, under the Landlock sandbox. Its command is not
a `rundown` call, so it has no entry of its own.

What this run does not hold:

- a sub-agent command: the agent started no sub-agent;
- a refusal or a failed step: every command exited 0;
- a nested command made by the agent's run: the only nested entry is the
  harness's recorder check.

The harness ended this run with `E2E FAILED`. Its last phase looks for a plan
file named `*-plan.json`, and this build writes
`.rundown/work/<context>/<run id>/plan.json`. That phase is replaced in #951.

## `sub-agent-check`

A run in the same kind of image, made only to get a sub-agent command and a
nested command that the transcript shows. It used the harness's workspace
preparation, one extra runbook (`nested-check.runbook.md`, a single step whose
command is `rundown --version`), and this prompt in place of the harness prompt:

> Do exactly these three things in order, then stop. 1. Run the shell command
> `rundown ls` yourself. 2. Use the Agent tool to start one sub-agent, and tell
> it to run the shell command `rundown status` in the current directory and
> return the exact output. Do not run that command yourself. 3. Run the shell
> command `rundown run nested-check.runbook.md --yes` yourself. Then report the
> exit code of each of the three commands.

| Transcript command (source)                        | Record entry                                                   |
| -------------------------------------------------- | -------------------------------------------------------------- |
| `rundown ls` (main)                                | `rundown ls`, top-level, exit 0                                |
| `rundown status` (sub-agent)                       | `rundown status`, top-level, exit 0                            |
| `rundown run nested-check.runbook.md --yes` (main) | `rundown run nested-check.runbook.md --yes`, top-level, exit 0 |

The record holds one more entry: the step's `rundown --version`, marked nested,
with the `rundown run` entry as its parent. The step ran under the Landlock
sandbox.

The prompt told the agent which commands to run, so this says nothing about how
an agent behaves in a runbook. No runbook on this build hands work to a
sub-agent: delegation is refused until #904. When it returns, a real delegated
run must be compared with its record.

## What the runs showed about the record

- A nested entry comes before its parent in the file, because an entry is
  written when its call ends. Order by `started_at` or follow `parent_id`.
- The record does not say who made a call. The sub-agent's `rundown status` is
  told apart from the main agent's commands only by the transcript.
- The agent adds to its commands (`; echo "exit=$?"`, `git checkout … &&`). The
  record holds the `rundown` call alone, so a comparison matches on arguments
  and time, not on the whole shell command.
