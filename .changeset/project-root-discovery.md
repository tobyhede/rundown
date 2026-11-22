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
directory or file, after that directory's own `.rundown/`). A walk that reaches
the git boundary without a match resolves to the git root, so the first
`rundown run` from a subdirectory of a fresh repository creates `.rundown/` at
the git root rather than a nested store a later command from the root would
miss. The walk never reads an ancestor of the home directory, nor home itself
unless home holds `.git`: a stray `~/.rundown/` cannot capture non-git
directories below home, while a repository rooted at home (dotfiles in `~`, a
container with `HOME=/app`) is found from its subdirectories. Outside git, with
no match, the root is the working directory itself. A nested `.rundown/` shadows
an outer one, and the walk never creates `.rundown/`. The store, project runbook
discovery, persisted runbook references, outputs and artifacts, `prune`, the
policy `{repo}` root and `.rundown/config.yaml` all use it. Paths typed on the
command line — a relative runbook path, `--input-file`, `file:` values in
`--input` / `--input-json`, and `--helpers` — still resolve against the working
directory, and the policy-file search still starts there, so a sub-package's
stricter policy wins over the root's. Core also exports `canonicalPath`, the one
realpath-or-resolve helper the CLI and plugin now share.

Step commands run in the run's **launch directory**: the directory `rundown run`
was invoked from, recorded on the run relative to the project root
(`launchDir`). Every command of the run executes there, whoever continues it and
from wherever, and inline and delegated children inherit it. Because commands no
longer run at the root, every Rundown-owned location a command receives is
absolute: `RD_WORK_PATH` and `{{ WorkPath }}` in command text name
`<root>/.rundown/work`, alongside the already-absolute `RD_OUTPUTS_*` paths and
`{{ path "..." }}` projections.

`.rundown/config.yaml` is now read from the project root only, so a nested
project without a config no longer picks up an outer project's.

The plugin's SubagentStop gate maps `CLAUDE_PROJECT_DIR` and the hook's `cwd` to
their project roots the same way, so a sub-agent that claimed a child from a
subdirectory is still held until it finishes or releases it.
