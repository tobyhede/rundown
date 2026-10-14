---
'@rundown-org/core': minor
'@rundown-org/cli': minor
'@rundown-org/claude-code-plugin': minor
---

# Commands run from a subdirectory act on the project

The run store, project runbooks, run outputs and artifacts all lived under the
CLI's working directory, while `.rundown/config.yaml` and the policy files were
found by walking up from it. A sub-agent that `cd`'d into a subdirectory and ran
`rundown claim` opened a different, empty store and was refused
`UNKNOWN_TICKET`; a `rundown run` there started a run nobody else could see.

Every command now resolves the **project root** once, with core's new
`resolveProjectRoot`: the nearest directory at or above the working directory
that contains an existing `.rundown/`, stopping at a git boundary (`.git`
directory or file, after that directory's own `.rundown/`) or the filesystem
root, and otherwise the working directory itself. A nested `.rundown/` shadows
an outer one, and the walk never creates `.rundown/`. The store, project runbook
discovery, persisted runbook references, outputs and artifacts, `prune`, step
command working directory, policy discovery and `.rundown/config.yaml` all use
it. `rundown run` where no `.rundown/` exists above still creates one in the
working directory. A relative runbook path typed on the command line is still
tried against the working directory.

`.rundown/config.yaml` is now read from the project root only, so a nested
project without a config no longer picks up an outer project's.

The plugin's SubagentStop gate maps `CLAUDE_PROJECT_DIR` and the hook's `cwd` to
their project roots the same way, so a sub-agent that claimed a child from a
subdirectory is still held until it finishes or releases it.
