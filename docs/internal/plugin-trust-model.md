# Claude Code Plugin Trust Model

Rundown's Claude Code plugin is a **thin, fixed front end** to the core state
machine. It exists only to (a) run runbooks via skill instructions and (b) keep
delegation between Claude Code subagents safe. It is NOT a general,
repo-configurable hook engine.

## Trust boundaries

| Source                                                        | Trust     | Plugin behavior                                         |
| ------------------------------------------------------------- | --------- | ------------------------------------------------------- |
| Plugin-owned code + bundled skills/runbooks                   | Trusted   | Loaded and executed                                     |
| Project `rundown-plugin.json` / `.claude/rundown-plugin.json` | Untrusted | **Ignored.** Never read.                                |
| Project `.claude/context/**`                                  | Untrusted | **Ignored.** Never injected.                            |
| Gate `command` shell strings                                  | Removed   | No gate executes shell.                                 |
| Cross-plugin `{ plugin, gate }` refs                          | Removed   | No cross-plugin invocation.                             |
| Runbook source files                                          | Project   | Executed by core only when a human/agent runs `rd run`. |

## Surviving repo-directory operations

Two narrow, intentional operations still touch the project directory. Both are
part of the delegation program, operate on project-owned data, and have no
shell-injection surface:

- `rd status` is spawned via
  `execFileSync('node', [cliPath, 'status'], { cwd })` (argv array, no shell)
  with the repo as `cwd`, best-effort, to enrich delegation context.
- The plugin reads/writes `<repo>/.claude/session/state.json` to track active
  delegation tokens.

Note that `.claude/session/state.json` lives inside the (untrusted) project
directory, so an opened repository can pre-populate or overwrite it. This input
is hardened: it is schema-validated on read, reinitialized if corrupt, and only
ever stores token _hashes_ that are compared — never executed, shell-expanded,
or echoed back as instructions. The worst case from a hostile file is therefore
**bounded delegation-UX degradation** (e.g. spoofing or clearing the plugin's
view of active delegation tokens), not shell execution, instruction injection,
or a safety-gate bypass — the SubagentStop enforcement gate derives closure from
core state, not from this file.

## Why

Opening an untrusted repository in Claude Code must not be able to: execute
shell through plugin hook config (#463 Critical); inject attacker-authored
Markdown as agent instructions (#463 High); disable the bundled delegation
safety hooks (#463 High); or invoke sibling-plugin gates as a confused deputy
(#463 Medium). The only way to guarantee this by construction is to remove
repo-controlled config, context, and shell gates entirely — not to sandbox them.

## Supported hook surface

Two native Claude Code hook events, wired in `hooks/hooks.json`:

- `PreToolUse` (matcher `Agent|Task`): delegation dispatch.
- `SubagentStop`: enforce explicit delegation closure. This is an enforcement
  gate and fails **closed**: if it cannot determine closure state (e.g. a
  session-I/O error), it returns a blocking decision rather than allowing the
  stop, so the dispatcher's generic fail-open backstop can never silently bypass
  it.

There is no plugin hook for "runbook start". Runbooks are launched by skills
instructing the agent to run `rd run <name>`; the CLI and core own execution.
