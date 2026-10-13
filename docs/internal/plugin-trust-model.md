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
own. The one read is the `SubagentStop` gate's: for each of the session's
project directory (`CLAUDE_PROJECT_DIR`, which Claude Code exports to command
hooks and which does not follow `cd`) and the hook input's `cwd` (which does)
where `.rundown/rundown.db` exists, it spawns
`rundown status --claimed-by <agent_id>` (read-only) there; where the store does
not exist it spawns nothing, so a project that never ran Rundown never gets a
store from the plugin. The CLI itself stores runs under its own working
directory (`process.cwd()`), which predates #907.

## Why

Opening an untrusted repository in Claude Code must not be able to: execute
shell through plugin hook config (#463 Critical); inject attacker-authored
Markdown as agent instructions (#463 High); disable the bundled safety hooks
(#463 High); or invoke sibling-plugin gates as a confused deputy (#463 Medium).
The only way to guarantee this by construction is to remove repo-controlled
config, context, and shell gates entirely — not to sandbox them.

## Supported hook surface

Two native Claude Code hook events (three routes), wired in `hooks/hooks.json`:

- `PreToolUse` (matcher `Agent|Task`): `gates/on-delegation-dispatch.ts`. A
  prompt (or description) carrying the Claim Ticket marker — one line
  `RD_CLAIM_TICKET=rdt_…`, defined in `shared/claim-ticket-marker.ts` — is
  dispatched with the claim instructions appended to the subagent's prompt
  (`updatedInput`; a PreToolUse `additionalContext` would reach the caller, not
  the subagent). A prompt marking two tickets, a marker that is not a ticket, or
  any other line naming `RD_CLAIM_TICKET` (inline code, trailing text,
  mid-sentence) is blocked rather than sent without its claim instructions. Any
  line ending, CRLF included, ends a marker. An unmarked dispatch is untouched.
- `PreToolUse` (matcher `Bash`): `gates/on-bash-command.ts`, with the small
  reader in `workflow/hooks/shell-command.ts`. A `rundown claim` /
  `rundown release` it reads with confidence — `rundown`, its short bin,
  `npx @rundown-org/cli`, or the CLI's `cli.js` under `node`, at a simple
  command position in a plain command or an `&&` / `;` / `|` chain, behind
  `VAR=x`, `env`, `timeout N`, `nice`, `npx` or `pnpm exec`, with the subcommand
  right after the binary — is rewritten in place to carry
  `--agent-id '<agent_id>'` from the hook input, and any `--agent-id` the agent
  typed is removed. Without an `agent_id` (the top-level agent), such a `claim`
  is denied (`CLAIM_OUTSIDE_SUBAGENT`) and such a `release` is only stripped, so
  it matches only a claim recorded without one. Everything else — every other
  command, and any command it cannot read with confidence (a here-document,
  command substitution, an expansion in command position, `sh -c`, `eval`,
  global options before the subcommand) — passes through byte for byte, never
  denied on doubt, so the user's Bash permission rules still match it as typed
  (a prefix on every command broke every allow rule; #907 review). The rewrite
  carries no `permissionDecision`, so Claude Code applies the user's rules to it
  and the hook never approves anything. The gate loads no part of
  `@rundown-org/core`; the two other gates load it lazily.

  The CLI fails closed on what the hook misses (core's `resolveDelegationAgent`,
  given the `--agent-id` values and whether `CLAUDECODE=1`, which Claude Code
  sets in every Bash tool command): inside Claude Code a `claim` without
  `--agent-id` is refused `AGENT_ID_REQUIRED`, and anywhere `--agent-id` given
  twice — the stamp plus one smuggled in through a variable — is refused
  `INVALID_SYNTAX`, never last-wins.

- `SubagentStop`: `gates/on-subagent-stop.ts`. It asks the CLI
  (`rundown status --claimed-by <agent_id>`) which Delegations still hold the
  stopping subagent — core's `delegationsHeldBy`: running, claimed under that
  agent id, and still counted by their parent — and blocks with the
  finish-or-release instruction while any does. It keeps no counter, so a
  subagent that ignores the instruction is blocked on every stop until a person
  interrupts it (accepted in ADR 0005). It allows the stop once each child is
  finished, abandoned (released) or cancelled.

The `SubagentStop` gate fails **closed** around its handler: a thrown error (the
CLI could not answer) becomes a blocking decision rather than reaching the
dispatcher's generic fail-open backstop. The Bash stamp and the dispatch
decision are pure functions of the tool input with no error path.

**Threat model.** The stamp guards against agent confusion — an agent that
passes another's id, or the orchestrator claiming its own child — not against a
malicious agent. One that deliberately hides a whole `--agent-id` from the
reader (in an expansion at command position, say
`rundown $S <ticket> --agent-id other`), or strips `CLAUDECODE` from its own
environment (`env -i`, `sudo`), defeats it; that is an adversarial act outside
this model, and the plugin does not try to stop it.

The Codex plugin runs no hooks, and outside Claude Code `CLAUDECODE` is unset
(for MCP, a person, and the scenario harness, which clears `CLAUDECODE` and
`CLAUDE_CODE_ENTRYPOINT` for its commands), so an unnamed claim records no
agent. A Codex subagent passes one stable `--agent-id` of its own by hand on
`claim` and `release` (its `running-runbooks` skill says so), and nothing holds
its stop.

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
