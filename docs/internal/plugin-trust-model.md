# Claude Code Plugin Trust Model

Rundown's Claude Code plugin is a **thin, fixed front end** to the core state
machine. It exists to run runbooks via skill instructions; its two hooks are
reserved for delegation between Claude Code subagents. Delegation itself runs
through the CLI (#904); the hooks that stamp a subagent's identity on `claim`
and gate its stop are rebuilt in #907 and are inert until then. It is NOT a
general, repo-configurable hook engine.

## Trust boundaries

| Source                                                        | Trust     | Plugin behavior                                              |
| ------------------------------------------------------------- | --------- | ------------------------------------------------------------ |
| Plugin-owned code + bundled skills/runbooks                   | Trusted   | Loaded and executed                                          |
| Project `rundown-plugin.json` / `.claude/rundown-plugin.json` | Untrusted | **Ignored.** Never read.                                     |
| Project `.claude/context/**`                                  | Untrusted | **Ignored.** Never injected.                                 |
| Gate `command` shell strings                                  | Removed   | No gate executes shell.                                      |
| Cross-plugin `{ plugin, gate }` refs                          | Removed   | No cross-plugin invocation.                                  |
| Runbook source files                                          | Project   | Executed by core only when a human/agent runs `rundown run`. |

## Repo-directory operations

The hooks perform none. Neither hook spawns the CLI, and neither reads or writes
any file under the project directory: both handlers are inert (see
[Supported hook surface](#supported-hook-surface)).

## Why

Opening an untrusted repository in Claude Code must not be able to: execute
shell through plugin hook config (#463 Critical); inject attacker-authored
Markdown as agent instructions (#463 High); disable the bundled safety hooks
(#463 High); or invoke sibling-plugin gates as a confused deputy (#463 Medium).
The only way to guarantee this by construction is to remove repo-controlled
config, context, and shell gates entirely — not to sandbox them.

## Supported hook surface

Two native Claude Code hook events, wired in `hooks/hooks.json`:

- `PreToolUse` (matcher `Agent|Task`): `gates/on-delegation-dispatch.ts`.
- `SubagentStop`: `gates/on-subagent-stop.ts`.

Both handlers (`workflow/hooks/delegation-dispatch.ts`,
`workflow/hooks/subagent-stop.ts`) are currently **inert**: every call returns
an empty result, so the gate allows the tool use or the stop with no injected
context. The registrations stay so the delegation behaviour (#907) lands in
place. The `SubagentStop` gate still fails **closed** around its handler: a
thrown error becomes a blocking decision rather than reaching the dispatcher's
generic fail-open backstop.

There is no plugin hook for "runbook start". Runbooks are launched by skills
instructing the agent to run `rundown run <name>`; the CLI and core own
execution.

## Subprocess lifecycle-mutation boundary

The plugin (and the MCP server) reach the CLI by spawning a subprocess
(`workflow/hooks/rundown.ts`, `execFileSync` with an argv array, no shell). The
spawn seam applies no authority gate of its own: a mutating command names its
run with `--token <owner_token>`, and the CLI refuses a bare or unknown-token
mutation itself (`TOKEN_REQUIRED`, `UNKNOWN_TOKEN`). The Owner Token is the only
mutation authority, whoever spawns the command, so a subprocess caller needs no
trust classification. See
[Lifecycle Command Seam](./architecture.md#lifecycle-command-seam) for the core
side.
