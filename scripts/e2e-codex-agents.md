# Rundown-aware Codex session (E2E harness)

This `AGENTS.md` is placed in the Codex working directory by the Rundown E2E
harness (`scripts/e2e-codex-shell-entrypoint.sh`). Codex reads `AGENTS.md` from
the working directory on startup, so these instructions are how the harness
wires Rundown into a Codex session — the equivalent of `--plugin-dir` for the
Claude entrypoint.

## What Rundown gives you here

Rundown is installed globally in this container. The `rd` (alias `rundown`) CLI
drives runbook execution through a state machine: you ask the CLI what to do
next, perform the step, then report the result back. The CLI tracks state in
`.rundown/` so progress survives across commands.

## Core loop

1. Discover runbooks: `rd ls --all`
2. Start a runbook: `rd run <name>` (JSON output by default; add `--text` for
   human-readable events).
3. Inspect current state at any time: `rd status`
4. Perform the step the runbook describes, then report the outcome:
   - `rd pass` — the step succeeded; advance.
   - `rd fail` — the step failed; the runbook's handler decides what happens.
5. Repeat until the runbook completes. Runbooks auto-complete on the final step;
   `rd complete` forces early completion and `rd stop [message]` aborts.

## Useful commands

- `rd check <file>` — validate a runbook without running it.
- `rd goto <step>` — jump to a step (e.g. `rd goto 3` or `rd goto 3.1`).
- `rd resolve <file>` — resolve and validate variables and data sources.
- `rd ls` — list active runbooks; `rd prune` clears completed/stopped state.

## Rules

- Always invoke the `rd` CLI to advance runbook state. Do not hand-edit files
  under `.rundown/` — that is the state machine's persisted state.
- Treat **result** (pass/fail), **handler** (configured result→action mapping),
  and **action** (what happens next) as distinct. You only report results; the
  runbook decides the action.
- Run `rd status` whenever you are unsure of the current step.
