# Command record proof runs

These files are the proof that issue #949 asks for: the command record holds
every `rundown` command that is visible in the agent's transcript. The command
record is the file the E2E container's recorder writes, one JSON line per
`rundown` or `rd` call (see
[ADR 0007](../../../../docs/adr/0007-observed-agent-runs-are-the-primary-oracle.md)
and `scripts/e2e-command-recorder.mjs`).

Both runs were made on 2026-11-23 in the E2E image built from commit
`8411baae6`, on a Linux arm64 VM with Landlock turned on. The agent was Claude
Code 2.1.330 with the model `claude-opus-5-5`. The image installs the newest
Claude Code when it is built, so the harness does not pin the agent version.

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

### `harness-run`

The unchanged harness, `pnpm run test:e2e`.

| Transcript command (source)                  | Record entry                                             |
| -------------------------------------------- | -------------------------------------------------------- |
| `rundown run rundown:end-to-end-test` (main) | `rundown run rundown:end-to-end-test`, top-level, exit 1 |

The record holds four more entries, all made by the harness itself and not by
the agent: the Landlock check (`rd run check.runbook.md --yes`), the recorder
check (`rd run recorder-check.runbook.md --yes`, with the step's
`rundown --version` as a nested entry), and the `rd status` the harness runs
after the agent ends.

The agent made one command because this build refuses the runbook the harness
prompt names (`RUNBOOK_COMPOSITION_UNSUPPORTED`). The agent reported the refusal
and stopped. This run holds no sub-agent command.

### `contrived-run`

A second run in the same image, made only to get a sub-agent command and a
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

## Result

No command is missing from either record.

Three things the runs also showed:

- A nested entry comes before its parent in the file, because an entry is
  written when its call ends. Order by `started_at` or follow `parent_id`.
- The record does not say who made a call. The sub-agent's `rundown status` is
  told apart from the main agent's commands only by the transcript.
- The agent adds to its commands (`; echo "exit=$?"`). The record holds the
  `rundown` call alone, so a comparison matches on arguments and time, not on
  the whole shell command.
