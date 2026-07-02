# Claude Code Plugin Hook Behavior

**Status:** Current implementation summary **Scope:**
`packages/claude-code-plugin`

This document describes what the Rundown Claude Code plugin hooks do today. The
plugin is a **thin, fixed delegation router** — not a repo-configurable gate or
context engine. For the security rationale behind this design, see
[docs/internal/plugin-trust-model.md](../../internal/plugin-trust-model.md).

## Overview

The plugin registers exactly **two** native Claude Code hook events in
`hooks/hooks.json`, both routed to the single CLI entrypoint (`dist/cli.js`)
over stdin:

| Hook           | Matcher       | Purpose                             |
| -------------- | ------------- | ----------------------------------- |
| `PreToolUse`   | `Agent\|Task` | Delegation dispatch (Agent/Task)    |
| `SubagentStop` | `.*`          | Enforce explicit delegation closure |

There is no other hook surface. The plugin's only CLI mode is native hook
dispatch over stdin — there are no `session`, `log-path`, or `log-dir`
subcommands.

## The Dispatcher

The router lives in `src/dispatcher.ts`: a small, typed function that receives
the already-parsed `HookInput` from the CLI layer (`src/cli.ts` reads and
validates stdin, then calls `dispatch(input)`) and routes it to one of two fixed
gates. It does not read stdin, project config, inject context files, synthesize
lifecycle events, or execute shell commands.

The two gates live in `src/gates/`:

| Gate                     | Fires on                        | Behavior                                                                                                                                                                              |
| ------------------------ | ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `on-delegation-dispatch` | `PreToolUse` for `Agent`/`Task` | Detects delegation tokens in the subagent prompt and injects claim instructions.                                                                                                      |
| `on-subagent-stop`       | `SubagentStop`                  | Resolves delegated child completion. **Fails closed:** if it cannot determine closure state (e.g. a session-I/O error), it returns a blocking decision rather than allowing the stop. |

## Runbook Launch

Runbooks are **not** auto-started by any plugin hook. They are launched by
skills that instruct the agent to run `rundown run <name>`; the CLI and core own
execution. There is no `runbook:` auto-start trigger and no command/skill
frontmatter scanning in the hook path.

## Surviving Repo Operations

Two narrow, intentional operations still touch the project directory, both part
of the delegation program and free of any shell-injection surface:

- `rundown status` is spawned via `execFileSync` with an argv array (no shell),
  best-effort, to enrich delegation context.
- The plugin reads/writes `<repo>/.claude/session/state.json` to track active
  delegation tokens. This file is schema-validated on read, reinitialized if
  corrupt, and only ever stores token _hashes_ that are compared — never
  executed or echoed back as instructions.

## What Was Removed

The following were part of an earlier, broader hook engine and have been removed
(see #463 and the [trust model](../../internal/plugin-trust-model.md)):

- Repo-configurable `rundown-plugin.json` (project root or `.claude/`) — no
  longer read.
- Shell-command gates executing via `child_process` — removed.
- Cross-plugin `{ plugin, gate }` references — removed.
- `.claude/context/**` and plugin `context/` injection as additional context —
  removed; context files are not injected.
- Synthetic lifecycle events (`SlashCommandStart`, `SlashCommandEnd`,
  `SkillStart`, `SkillEnd`) — these are not native Claude Code events; the
  plugin no longer synthesizes them.
- The broad multi-event hook matrix (`SessionStart`, `SessionEnd`,
  `UserPromptSubmit`, `Stop`, `PostToolUse`, `SubagentStart`, `Notification`,
  `PreCompact`, and others) — removed. Only `PreToolUse` and `SubagentStop`
  remain.
- The delegated-bash guard (`PreToolUse` for `Bash`) — removed. It
  re-implemented core logic non-authoritatively: core's
  `resolveTransitionTarget` already refuses a bare `rundown pass`/`rundown fail`
  while the parent run has open delegated children. The `PreToolUse` matcher
  narrowed from `Agent|Task|Bash` to `Agent|Task`.
