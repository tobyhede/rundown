# Claude Code Plugin Hook Behavior

**Status:** Current implementation summary **Scope:**
`packages/claude-code-plugin`

This document describes what the Rundown Claude Code plugin hooks do today. The
plugin is a **thin, fixed delegation router** — not a repo-configurable gate or
context engine. For the security rationale behind this design, see
[docs/internal/plugin-trust-model.md](../../internal/plugin-trust-model.md).

## Overview

The plugin registers three native Claude Code hook routes in `hooks/hooks.json`,
all sent to the single CLI entrypoint (`dist/cli.js`) over stdin:

| Hook           | Matcher       | Purpose                                                     |
| -------------- | ------------- | ----------------------------------------------------------- |
| `PreToolUse`   | `Agent\|Task` | Claim Ticket dispatch: append the claim instructions        |
| `PreToolUse`   | `Bash`        | Stamp `--agent-id` on plain claim and release commands      |
| `SubagentStop` | `.*`          | Hold a sub-agent that still holds a claimed delegated child |

There is no other hook surface. The plugin's only CLI mode is native hook
dispatch over stdin — there are no `session`, `log-path`, or `log-dir`
subcommands.

## The Dispatcher

The router lives in `src/dispatcher.ts`: a small, typed function that receives
the already-parsed `HookInput` from the CLI layer (`src/cli.ts` reads and
validates stdin, then calls `dispatch(input)`) and routes it to one of three
fixed gates. It does not read project config, inject context files, synthesize
lifecycle events, or execute shell commands. The Bash gate is imported
statically and loads nothing beyond a string prefix; the two gates that need
`@rundown-org/core` are imported lazily, so a Bash call never loads core.

The gates live in `src/gates/`:

| Gate                     | Fires on                        | Behavior                                                                                                                                                                                                                                                                                                                                                      |
| ------------------------ | ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `on-delegation-dispatch` | `PreToolUse` for `Agent`/`Task` | Finds the `RD_CLAIM_TICKET=<ticket>` marker line and appends the claim instructions to the prompt. Several tickets, or any line naming `RD_CLAIM_TICKET` that is not an exact marker, block the dispatch.                                                                                                                                                     |
| `on-bash-command`        | `PreToolUse` for `Bash`         | Rewrites a `rundown claim` / `rundown release` it reads with confidence to carry `--agent-id '<agent_id>'` (removing any typed), and denies such a claim with no `agent_id` (`CLAIM_OUTSIDE_SUBAGENT`). Every other command, including one it cannot read, passes byte for byte; the CLI refuses an unstamped claim inside Claude Code (`AGENT_ID_REQUIRED`). |
| `on-subagent-stop`       | `SubagentStop`                  | Asks `rundown status --claimed-by <agent_id>` in `CLAUDE_PROJECT_DIR` and in the hook's `cwd`, and blocks while a claimed child is running and counted. **Fails closed:** if the CLI cannot answer, it returns a blocking decision rather than allowing the stop.                                                                                             |

## Runbook Launch

Runbooks are **not** auto-started by any plugin hook. They are launched by
skills that instruct the agent to run `rundown run <name>`; the CLI and core own
execution. There is no `runbook:` auto-start trigger and no command/skill
frontmatter scanning in the hook path.

## Surviving Repo Operations

One narrow, intentional operation touches the project directory, free of any
shell-injection surface: the SubagentStop gate spawns
`rundown status --claimed-by` via `execFileSync` with an argv array (no shell),
and only where a Rundown store already exists. The plugin keeps no state of its
own: the `.claude/session/state.json` session file and its lock were deleted in
#907.

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
  while the parent run has open delegated children. The `Bash` matcher returned
  in #907 for the agent-id stamp only, which decides nothing itself.
- The plugin session file (`.claude/session/state.json`) and `PluginSessionLock`
  — removed in #907.
