# Claude Code Plugin Trust Model

Rundown's Claude Code plugin is a **thin, fixed front end** to the core state
machine. It exists to run runbooks via skill instructions; its hooks serve only
delegation between Claude Code subagents (ADR 0005): they hand a Claim Ticket to
the subagent it was dispatched to, stamp that subagent's identity on
`rundown claim` and `rundown release`, and hold its stop while it has a claimed
child to finish. Delegation itself runs through the CLI; every rule the hooks
apply is decided by core. It is NOT a general, repo-configurable hook engine.

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

The hooks write nothing under the project directory and keep no state of their
own. The one read is the `SubagentStop` gate's: when `.rundown/rundown.db`
exists it spawns `rundown status --claimed-by <agent_id>` (read-only) in the
hook input's `cwd`; when the store does not exist it spawns nothing, so a
project that never ran Rundown never gets a store from the plugin.

## Why

Opening an untrusted repository in Claude Code must not be able to: execute
shell through plugin hook config (#463 Critical); inject attacker-authored
Markdown as agent instructions (#463 High); disable the bundled safety hooks
(#463 High); or invoke sibling-plugin gates as a confused deputy (#463 Medium).
The only way to guarantee this by construction is to remove repo-controlled
config, context, and shell gates entirely — not to sandbox them.

## Supported hook surface

Two native Claude Code hook events, wired in `hooks/hooks.json`:

- `PreToolUse` (matcher `Agent|Task`): `gates/on-delegation-dispatch.ts`. A
  prompt (or description) carrying the Claim Ticket marker — one line
  `RD_CLAIM_TICKET=rdt_…`, defined in `shared/claim-ticket-marker.ts` — is
  dispatched with the claim instructions appended to the subagent's prompt
  (`updatedInput`; a PreToolUse `additionalContext` would reach the caller, not
  the subagent). A prompt marking two tickets, or a marker that is not a ticket,
  is blocked. An unmarked dispatch is untouched.
- `PreToolUse` (matcher `Bash`): `gates/on-bash-command.ts`. Every
  `rundown claim` / `rundown release` in the command (also `rd`, behind
  `cd …&&`, `VAR=…`, `env`, `npx`, global options, pipes and redirections) is
  rewritten to carry `--agent-id '<agent_id>'` from the hook input, and any
  `--agent-id` the agent typed is removed, so no agent can claim or release
  under another's id. Without an `agent_id` (the top-level agent), `claim` is
  denied and `release` is stripped of any `--agent-id`, so it matches only a
  claim recorded without one. A command hiding a claim or release where the
  scanner cannot see — command substitution, backticks, here-documents, `sh -c`,
  `eval`, `xargs` — is denied rather than run unstamped. The rewrite carries no
  `permissionDecision`: Claude Code applies the user's permission rules to the
  rewritten command, so the hook never approves anything.
- `SubagentStop`: `gates/on-subagent-stop.ts`. It asks the CLI
  (`rundown status --claimed-by <agent_id>`) which Delegations still hold the
  stopping subagent — core's `delegationsHeldBy`: running, claimed under that
  agent id, and still counted by their parent — and blocks with the
  finish-or-release instruction while any does. It keeps no counter, so a
  subagent that ignores the instruction is blocked on every stop until a person
  interrupts it (accepted in ADR 0005). It allows the stop once each child is
  finished, abandoned (released) or cancelled.

Every enforcement gate fails **closed** around its handler: a thrown error
becomes a blocking decision rather than reaching the dispatcher's generic
fail-open backstop. The dispatch gate fails closed only for a dispatch that
names the marker; any other `Agent`/`Task` call is never blocked.

The Codex plugin runs no hooks. A Codex subagent passes one stable `--agent-id`
of its own by hand on `claim` and `release` (its `running-runbooks` skill says
so), and nothing holds its stop.

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
