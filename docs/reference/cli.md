# Rundown CLI Reference

This document is the user reference for the Rundown CLI (`rundown` / `rd`):
installation, quick start, command reference, and common tasks. For execution
model and runtime semantics, see [docs/reference/runtime.md](runtime.md). For
subagent delegation workflows, see
[docs/guides/agent-orchestration.md](../guides/agent-orchestration.md).

**For syntax and format details, see:**

- [docs/spec/language.md](../spec/language.md) — Rundown specification
- [docs/spec/grammar.md](../spec/grammar.md) — Format grammar and expansion
  rules
- [docs/guides/agent-orchestration.md](../guides/agent-orchestration.md) —
  Subagent delegation, context discovery, and delegation completion

---

## Table of Contents

- [Installation](#installation)
- [Quick Start](#quick-start)
  - [Runbook Discovery](#runbook-discovery)
- [Security Policy](#security-policy)
  - [Quick Reference](#security-quick-reference)
- [CLI Commands](#cli-commands)
  - [Runbook Lifecycle](#runbook-lifecycle)
  - [State Transitions](#state-transitions)
  - [Status Commands](#status-commands)
  - [Artifact Commands](#artifact-commands)
  - [Enforcement Control](#enforcement-control)
  - [Validation](#validation)
  - [Maintenance](#maintenance)
  - [Testing and Utilities](#testing-and-utilities)
  - [Delegation Commands](#delegation-commands)
- [Common Tasks](#common-tasks)
- [Delegation Patterns](#delegation-patterns)
  - [Pattern 1: Orchestrator Control](#pattern-1-orchestrator-control)
  - [Pattern 2: Agent-Controlled Branching](#pattern-2-agent-controlled-branching)
- [Output Format](#output-format)
  - [Standard Output Structure](#standard-output-structure)
  - [Table Output](#table-output)
  - [Detail Views](#detail-views)
  - [Command Execution Output](#command-execution-output)
  - [Key Elements](#key-elements)
- [Troubleshooting and Error Handling](#troubleshooting-and-error-handling)
  - [Common Errors and Resolutions](#common-errors-and-resolutions)
  - [State Recovery](#state-recovery)
- [Integration with Claude Code](#integration-with-claude-code)
- [CLI Quick Reference](#cli-quick-reference)

---

## Installation

```bash
npm install -g @rundown-org/cli
```

Verify installation:

```bash
rundown --help
```

Use `rundown` for every command. The package also installs a short `rd` binary
pointing at the same CLI, but oh-my-zsh ships a core `alias rd=rmdir` that
shadows it (shell aliases beat `PATH`), so **`rd` is unreliable** — prefer
`rundown`. On oh-my-zsh, restore the short name by adding `alias rd=rundown` to
`~/.zshrc` **after** oh-my-zsh loads.

---

## Quick Start

**Run a runbook:**

```bash
# Using an absolute path
rundown run /path/to/project/.rundown/runbooks/simple.runbook.md

# Or from the project root, with runbook in the standard location
rundown run simple.runbook.md
```

The CLI resolves runbook paths in this order:

1. Absolute path (used as-is)
2. Relative to current working directory
3. By name via the discovery chain: project (`.rundown/runbooks/`), then plugin
   (`$CLAUDE_PLUGIN_ROOT/runbooks/`), then bundled (CLI package
   `dist/runbooks/`) — see [Runbook Discovery](#runbook-discovery) below for the
   full priority table

### Runbook Discovery

When a runbook is referenced by name (rather than an explicit path), the CLI
searches multiple sources in priority order:

| Priority    | Source  | Location                        |
| ----------- | ------- | ------------------------------- |
| 1 (highest) | Project | `.rundown/runbooks/`            |
| 2           | Plugin  | `$CLAUDE_PLUGIN_ROOT/runbooks/` |
| 3           | Bundled | CLI package `dist/runbooks/`    |

Directories are scanned recursively, so nested layouts like
`planning/write-plan.runbook.md` are supported.

**Namespace syntax** — Use `namespace:name` to target a specific source
explicitly:

- `write-plan` — resolves via the priority chain above
- `rundown:write-plan` — explicit: from the plugin source only

`rundown ls --all` lists discoverable runbooks with a `SOURCE` column indicating
where each was found (`project`, `plugin`, or `bundled`).

**Check status:**

```bash
rundown status
```

**Progress through steps:**

```bash
rundown pass    # Step succeeded, apply PASS transition
rundown fail    # Step failed, apply FAIL transition
```

**Stop a runbook:**

```bash
rundown stop [message]
```

---

## Security Policy

Rundown enforces a security policy layer to control what commands, files, and
environment variables runbooks can access. See
[docs/reference/security.md](security.md) for full default policy details,
including command allow/block/prompt behavior, sandbox-on-by-default
enforcement, and the default write allowlist.

### Security Quick Reference

| Flag                    | Effect                                                                                   |
| ----------------------- | ---------------------------------------------------------------------------------------- |
| `--allow-run <cmds>`    | Allow specific commands (comma-separated)                                                |
| `--allow-read <paths>`  | Allow reading specific paths                                                             |
| `--allow-write <paths>` | Allow writing to specific paths                                                          |
| `--allow-env <vars>`    | Allow specific environment variables                                                     |
| `--allow-all`           | Bypass all policy checks                                                                 |
| `--deny-all`            | Block all operations not explicitly allowed                                              |
| `-y, --yes`             | Auto-approve prompts                                                                     |
| `--non-interactive`     | CI mode (auto-deny unlisted commands)                                                    |
| `--policy <file>`       | Use custom policy file                                                                   |
| `--trust-js-policy`     | Trust an explicitly selected JS policy file and helper modules declared by policy config |
| `--helpers <paths>`     | Helper module paths to load (comma-separated, relative to project root)                  |
| `--sandbox`             | Enable OS-level filesystem sandbox (default)                                             |
| `--no-sandbox`          | Disable sandbox enforcement; a general sandbox opt-out                                   |
| `--sandbox-strict`      | Fail if sandbox is unavailable (default; explicit affirmation of fail-closed)            |

Policy discovery is data-only by default: `.rundownrc`, `.rundownrc.json`,
`.rundownrc.yaml`, `.rundownrc.yml`, or the `rundown` field in `package.json`.
Executable `rundown.config.js/.cjs/.mjs` files are only loaded when passed via
`--policy` together with `--trust-js-policy`.

```bash
# Allow specific commands for this run
rundown run deploy.runbook.md --allow-run docker,kubectl

# CI/CD: strict mode with no prompts
rundown run test.runbook.md --non-interactive
```

---

## CLI Commands

### Runbook Lifecycle

#### `rundown run <file>` - Start Runbook

Start a new runbook from a runbook file.

```bash
rundown run my-runbook.runbook.md
rundown run my-runbook.runbook.md --prompted  # Disable automatic execution
rundown run my-runbook.runbook.md --text      # Emit execution events as human-readable text
rundown run my-runbook.runbook.md --input key=value  # Set template variable (repeatable)
rundown run my-runbook.runbook.md --input-json 'items=["a","b"]'  # Set variable with JSON value (repeatable)
rundown run my-runbook.runbook.md --input-file vars.yaml  # Load variables from YAML file (repeatable)
rundown run execute-plan.runbook.md --artifacts PlanPath=rd://artifacts/ctx/run/PlanPath  # Supply an input artifact (repeatable)
rundown run fanout.runbook.md --artifacts-json 'Plans=["rd://artifacts/ctx/run/p0","rd://artifacts/ctx/run/p1"]'  # JSON array of artifact URIs
rundown run my-runbook.runbook.md --step 2.1  # Link this run as a child of parent substep 2.1
rundown run my-runbook.runbook.md --step 2.1 --prompted  # Jump to step 2.1 after starting (goto)
rundown run my-runbook.runbook.md --step 2.1 --index 3  # Target FOR iteration 3 of step 2.1
```

**Flags:**

- `--prompted` — Show commands without auto-executing.
- `--text` — Output execution events as human-readable text (JSON is the
  default).
- `--input <key=value>` / `--input-json <key=json>` / `--input-file <path>` —
  Set template variables (all repeatable). `--input-json` carries JSON
  array/object values. `--input-file` paths must be project-relative and must
  remain inside the project directory after symlink resolution; absolute paths
  and `..` traversal are rejected.
- `--artifacts <key=rd://uri>` / `--artifacts-json <key=json-array>` — Supply
  **input artifacts** (both repeatable; declared via frontmatter `artifacts:`).
  Values MUST be `rd://artifacts/...` URIs (or, for `--artifacts-json`, a JSON
  array of such URIs) naming **existing** manifest rows — the channel is
  read-only and never mints rows; a non-`rd://` value is a hard error. This is a
  distinct boundary channel from `--input*`: `--input X=rd://...` is a plain
  string and no longer rehydrates, and supplying the same name via both channels
  is an error. There is intentionally **no `--artifacts-file`** and no
  `KEY`-only env-inherit form (both deferred).
- `--step <stepId>` — Link this run to a parent substep for inline nested
  execution; with `--prompted`, jumps to the step after starting.
- `--index <number>` — FOR loop iteration to target (requires `--step`).

**Behavior:**

1. Parse runbook file
2. Create runbook state with unique ID
3. Push runbook to session stack
4. Enter execution loop

**Execution Loop:**

- Auto-execute bash code blocks (unless `--prompted`)
- Exit code 0 = PASS, non-zero = FAIL
- Stop at prompt-only steps (no code block)
- Continue until COMPLETE or STOP

**With `--prompted`:**

- Commands displayed but not executed
- Agent must run command manually
- Use `rundown pass` or `rundown fail` after command

#### `rundown stop` - Abort Runbook

Immediately terminate the active runbook.

```bash
rundown stop [message]
```

Marks the runbook as stopped, preserves the stopped state file for inspection,
and removes it from the active session stack. Bare `rundown stop` is a failure
terminal and exits non-zero.

**Flags:**

- `--run <runId>` — Name the run you control (explicit orchestrator targeting).
- `--claim-capability <claimCapability>` — Target a claimed delegated child
  runbook.

On a delegation-exposed run the bare form is refused with
`ACTOR_CONTEXT_REQUIRED`; pass `--run-capability <run_capability>`
(orchestrator) or `--claim-capability <claim_capability>` (delegated child).
Standalone runs (no delegation activity) still accept the bare form.

<a id="force-terminal-targeting"></a>

When the active runbook is an inline-composed child, bare `rundown complete` and
bare `rundown stop` target the outermost contiguous-inline ancestor. The inline
child runs in that active chain are forced to the same terminal lifecycle so no
running inline descendants remain under a terminal parent.

This targeting rule stops at delegation boundaries. If the inline root is a
delegated child, it reports its terminal outcome to the delegating parent, and
the delegating parent advances only after
`rundown collect --run-capability <run_capability>`.

`--claim-capability` keeps delegated-child mutation scope:
`rundown complete --claim-capability <claim_capability>` and
`rundown stop --claim-capability <claim_capability>` target that claimed child
directly.

These bare force-terminal overrides are not the same as handler-derived
`COMPLETE` / `STOP` actions authored in a runbook's transitions; the latter are
results of normal step execution, not workflow-level CLI overrides.

Bare `rundown complete` and `rundown stop` stream terminal observation events
(`step_transitioned`, then `runbook_completed` / `runbook_stopped`) before the
final action object, so their JSON output is newline-delimited — parse the last
line for the action object. See
[docs/spec/cli-output.md](../spec/cli-output.md#complete) for the full output
shape.

#### `rundown complete [message]` - Force Early Completion

Manually complete a runbook before reaching the final step.

**Note:** Runbooks auto-complete when the final step's PASS transition executes
and there are no more steps. This command is only needed for early exit
scenarios.

```bash
rundown complete                            # Force completion from current step
rundown complete "Skipping remaining steps" # Complete with message
rundown complete --run-capability <run_capability>               # Orchestrator-targeted completion
```

**Flags:**

- `--run <runId>` — Name the run you control (explicit orchestrator targeting).
- `--claim-capability <claimCapability>` — Target a claimed delegated child
  runbook.

On a delegation-exposed run the bare form is refused with
`ACTOR_CONTEXT_REQUIRED`; pass `--run-capability <run_capability>`
(orchestrator) or `--claim-capability <claim_capability>` (delegated child).
Standalone runs still accept the bare form.

**When to use:**

- Early exit when remaining steps are unnecessary
- Agent-driven workflows requiring explicit completion
- Graceful exit from steps without explicit completion transitions

**Comparison with `stop`:**

- `complete` - Marks runbook as **successful**, preserves state
- `stop` - Marks runbook as **aborted/failed**, preserves stopped state, and
  removes it from the active stack

### State Transitions

#### `rundown pass` - Mark Step Passed

Signal successful step completion.

```bash
rundown pass
rundown pass --step 2.1              # Target a specific substep
rundown pass --step 2.1 --index 3    # Target substep at FOR iteration 3
rundown pass --run-capability <run_capability>            # Orchestrator-targeted advance
rundown pass --claim-capability <claim_capability>   # Delegated child reports its result
```

**Aliases:** `rundown yes`, `rundown ok`

**Flags:**

- `--step <stepId>` — Target a specific substep (not the currently active one).
- `--index <number>` — FOR loop iteration to target (requires `--step`).
- `--run <runId>` — Name the run you control (explicit orchestrator targeting).
- `--claim-capability <claimCapability>` — Target a claimed delegated child
  runbook.

On a delegation-exposed run the bare form is refused with
`ACTOR_CONTEXT_REQUIRED`; pass `--run-capability <run_capability>`
(orchestrator) or `--claim-capability <claim_capability>` (delegated child).
Standalone runs still accept the bare form.

**Behavior:**

1. Send PASS event to XState
2. Evaluate PASS transition
3. Execute resulting action
4. Print action taken and new step

#### `rundown fail` - Mark Step Failed

Signal step failure.

```bash
rundown fail
rundown fail --step 2.1              # Target a specific substep
rundown fail --step 2.1 --index 3    # Target substep at FOR iteration 3
rundown fail --run-capability <run_capability>            # Orchestrator-targeted advance
rundown fail --claim-capability <claim_capability>   # Delegated child reports its result
```

**Alias:** `rundown no`

**Flags:**

- `--step <stepId>` — Target a specific substep (not the currently active one).
- `--index <number>` — FOR loop iteration to target (requires `--step`).
- `--run <runId>` — Name the run you control (explicit orchestrator targeting).
- `--claim-capability <claimCapability>` — Target a claimed delegated child
  runbook.

On a delegation-exposed run the bare form is refused with
`ACTOR_CONTEXT_REQUIRED`; pass `--run-capability <run_capability>`
(orchestrator) or `--claim-capability <claim_capability>` (delegated child).
Standalone runs still accept the bare form.

**Behavior:**

1. Send FAIL event to XState
2. Evaluate FAIL transition (may trigger RETRY)
3. Execute resulting action
4. Print action taken

For RETRY transitions:

- If `retryCount < max`: increment count, stay in step
- If exhausted: execute fallback action (default: STOP)

##### Exit codes for `pass` / `fail`

The exit code of a transition command reports **the action the runbook program
actually took**, not the verb you typed. It answers one question for a scripted
orchestrator: _has the workflow this process is driving halted?_

- **Exit non-zero** — the workflow this process drives has **halted**: its local
  lifecycle reached `stopped` with no parent that absorbs it, RETRY was
  exhausted, or — for an inline child — advancing the composing parent itself
  reached a STOP terminal.
- **Exit 0** — the workflow is **still progressing**, even when the result was a
  failure. A `rundown fail` whose failure the parent handles non-terminally
  (e.g. a `FAIL ANY` / `FAIL DEFER` parent that defers to the next sibling)
  exits 0: the failure is real and recorded in state and the JSON output, but
  the orchestrated workflow has not halted, so a `set -e`-style driver should
  keep going.

The result of the step (`pass` / `fail`) is a separate channel — it is always
recorded and emitted in the JSON output regardless of exit code. Exit 0 from
`rundown fail` never means the failure was swallowed; it means the runbook's
configured handler absorbed it without halting the workflow.

This contract is scoped to the **process** driving the workflow, which is why
inline and delegation children differ. An inline child shares one process with
its parent, so the exit code reflects the whole inline chain. A delegated child
runs in its own worker process, so closing it halts _that_ process's workflow
(exit non-zero on its own STOP) while the delegating parent advances later, in a
different process, via `rundown collect --run-capability <run_capability>`.

#### `rundown goto <step>` - Jump to Step

Navigate directly to a step.

```bash
rundown goto 3                # Jump to step 3
rundown goto 3.1              # Jump to substep 3.1
rundown goto 3 --index 2      # Jump to step 3 and enter FOR iteration 2
rundown goto 3 --run-capability <run_capability>   # Orchestrator-targeted jump
```

**Flags:**

- `--index <number>` — For FOR-annotated targets, enter the loop at the
  specified iteration.
- `--run <runId>` — Name the run you control (explicit orchestrator targeting).
- `--claim-capability <claimCapability>` — Target a claimed delegated child
  runbook.

On a delegation-exposed run the bare form is refused with
`ACTOR_CONTEXT_REQUIRED`; pass `--run-capability <run_capability>`
(orchestrator) or `--claim-capability <claim_capability>` (delegated child).
`goto` is additionally gated behind the `run-navigation` policy intent — the
run's policy must grant navigation for the jump to be allowed.

**Restrictions:**

- Target must exist
- Resets retryCount to 0
- Clears lastResult (prevents the previous result from leaking)

**Valid GOTO Formats (in runbook transitions):**

| Target           | Valid From | Description                                                                                            |
| ---------------- | ---------- | ------------------------------------------------------------------------------------------------------ |
| `GOTO N`         | Any step   | Jump to step N (if FOR step, AT defaults per [spec §6](../spec/language.md#6-transitions-and-actions)) |
| `GOTO N.M`       | Any step   | Jump to substep M of step N                                                                            |
| `GOTO Name`      | Any step   | Jump to named step                                                                                     |
| `GOTO Name.M`    | Any step   | Jump to substep M of named step                                                                        |
| `GOTO N AT I`    | Any step   | Enter FOR step N at iteration I (only if N is a FOR step)                                              |
| `GOTO N.M AT I`  | Any step   | Jump to substep M of FOR step N at iteration I                                                         |
| `GOTO Name AT I` | Any step   | Enter named FOR step at iteration I                                                                    |

The `AT` qualifier is only valid when the target is a step with a FOR
annotation. See
[docs/spec/language.md §6](../spec/language.md#6-transitions-and-actions) for
the authoritative AT default rule. See
[docs/spec/language.md Actions](../spec/language.md#6-transitions-and-actions)
for full details.

### Status Commands

#### `rundown status` - Show Current State

Display active runbook information.

```bash
rundown status          # JSON output by default
rundown status --text   # Human-readable text output
```

`status` emits JSON by default. Pass `--text` for the human-readable layout
shown below.

**Output (`--text`):**

```text
File:     my-runbook.runbook.md
State:    .rundown/runs/rd_0123456789abcdef0123456789abcdef.json
Action:   CONTINUE
Result:   PASS

For:      2/5
At:       3.2.1

Execute batch...
```

#### `rundown ls` - List Runbooks

List active or available runbooks.

```bash
rundown ls           # List active runbooks (JSON output by default)
rundown ls --all     # List available runbook files
rundown ls --all --tags review  # Filter by tag
```

**Active runbook status values:**

- `active` - Currently executing
- `stashed` - Paused via `rundown stash`
- `complete` - Successfully finished
- `stopped` - Terminated with failure
- `inactive` - In session but not active

**Columns (for `--all`):** `NAME`, `SOURCE`, `DESCRIPTION`, `TAGS`. The `SOURCE`
column indicates where each runbook was discovered (`project`, `plugin`, or
`bundled`) — see [Runbook Discovery](#runbook-discovery).

### Artifact Commands

```bash
rundown artifact ls                         # List artifact aliases visible in the active run context
rundown artifact inspect <Alias-or-uri>      # Return the full artifact record for an alias or manifest-backed exact URI
rundown artifact path <Alias-or-uri>         # JSON: full artifact record; --text: local path only
rundown artifact uri <Alias>                 # JSON: full artifact record; --text: canonical artifact URI only
```

Artifact commands are inspection/projection tools. They do not read or write
artifact file contents. JSON output is optimized for agents and includes both
`uri` and `path`; use `--text` on `path` or `uri` only when a shell-friendly
single projection is needed.

### Enforcement Control

#### `rundown stash` - Pause Enforcement

Temporarily pause runbook tracking.

```bash
rundown stash
```

Removes active runbook from stack, preserves state.

#### `rundown pop` - Resume Enforcement

Resume from stashed runbook.

```bash
rundown pop
```

Restores stashed runbook to active stack.

### Validation

#### `rundown check <file>` - Validate Runbook

Check a runbook file for syntax errors.

```bash
rundown check my-runbook.runbook.md          # JSON output by default
rundown check my-runbook.runbook.md --text   # Human-readable text output
```

`check` emits JSON by default. Pass `--text` for the human-readable layout shown
below.

**Output (`--text`):**

```text
PASS: 5 steps, 3 substeps
```

or

```text
FAIL: 2 errors

Line 15: Step 3 missing (expected sequential numbering)
Line 22: Invalid transition: GOTO 10 (step does not exist)
```

### Maintenance

#### `rundown prune` - Remove Runbook State

Clean up runbook state files (not runbook source files).

```bash
rundown prune               # Remove completed + stopped runbooks (default)
rundown prune --all         # Remove all runbook state
rundown prune --dry-run     # Preview what would be removed
rundown prune --completed   # Only completed
rundown prune --stopped     # Only stopped (aborted/failed)
rundown prune --inactive    # Only inactive
rundown prune --active      # Only active (careful!)
```

### Testing and Utilities

#### `rundown echo` - Test Helper

Echo command for runbook testing. Supports configurable pass/fail result
sequences (useful for exercising retry logic).

```bash
rundown echo [command...]
rundown echo -r pass                # Configure result (repeatable)
rundown echo -r fail -r pass        # Sequence: fail first, then pass
```

#### `rundown resolve <file>` - Resolve Variables

Resolve and validate template variables and data sources for a runbook without
executing it.

```bash
rundown resolve my-runbook.runbook.md
rundown resolve my-runbook.runbook.md --input environment=staging
rundown resolve my-runbook.runbook.md --input-json 'items=["a","b"]'  # JSON value
rundown resolve my-runbook.runbook.md --input-file vars.yaml          # YAML file
rundown resolve execute-plan.runbook.md --artifacts PlanPath=rd://artifacts/ctx/run/PlanPath  # Artifact channel
```

`--input`, `--input-json`, `--input-file`, `--artifacts`, and `--artifacts-json`
are all repeatable. `--artifacts` / `--artifacts-json` resolve `rd://` artifact
URIs the same way as `rundown run` (see that command's flags).

Useful for verifying that required variables are satisfied and data sources
resolve before running.

#### `rundown prompt <content>` - Emit Prompt Content

Output content wrapped in markdown fences. Used by the runtime to render
`prompt` code blocks; can also be invoked directly.

```bash
rundown prompt 'Review the implementation'
```

#### `rundown scenario` - Runbook Scenarios

List, show, or execute scenarios declared in a runbook's frontmatter (see
[docs/internal/scenarios.md](../internal/scenarios.md)).

```bash
rundown scenario ls <file>                  # List scenarios
rundown scenario show <file> <name>         # Show scenario details
rundown scenario run <file> <name>          # Execute and verify
rundown scenario run <file> <name> --quiet  # Suppress command output
```

Implementation notes:

- `scenario run` creates an isolated temp workspace, copies the scenario runbook
  into `.rundown/runbooks/`, copies referenced `*.runbook.md` children found in
  commands, and executes commands through `executeCommandSequence`.
- `rd`/`rundown` commands are spawned directly as `node <cliPath> ...` so JSON
  output can be captured; non-`rd` commands run through the shell.
- Scenario `commands:` should express the visible CLI workflow directly. Do not
  wrap `rd`/`rundown` calls in `node -e`, `bash -c`, npm scripts, helper
  scripts, or shell pipelines; hidden CLI calls are not visible to the scenario
  runner's state, token, claim-id, and transition capture. Put detailed payload
  assertions in Jest integration or unit tests instead.
- Leading command-scoped env assignments are supported for `rd` commands when a
  scenario needs them for unrelated command behavior. Shell operators in an `rd`
  command are rejected; split those commands into separate scenario entries.
- Prefix a command with `!` followed by a literal space when a non-zero exit is
  expected. If an expected-failure command exits 0, the scenario fails;
  otherwise the failed command is allowed to continue.
- During scenario execution, JSON warnings emitted by commands must be declared
  in `expect.warnings`; any unasserted warning fails the scenario even when the
  underlying command exits 0.
- Delegation tokens are captured from `rundown delegate` JSON responses and from
  `step_entered.delegateFrontier` auto-issued tokens. `${TOKEN}` expands to the
  first captured token, `${TOKEN_2}` to the second, and so on.
- Claim ids are captured from `rundown claim` JSON responses. `${CLAIM_ID}`
  expands to the first captured claim id, `${CLAIM_ID_2}` to the second, and so
  on.
- `--input-file` dependencies are copied by directory. Scenario execution copies
  the entire containing directory for each relative `--input-file` path so YAML
  files that contain sibling `file:` references keep working. Absolute paths and
  `..` traversal are rejected.

- Scenario `expect.entered` assertions match captured `step_entered` events. Use
  them to pin inline child entry points such as generated runbook-list substeps
  with descriptions like `Runbook: child.runbook.md`.

#### `rundown scenario-suite` - Scenario Suites

List, show, or execute cases from a scenario suite file.

```bash
rundown scenario-suite ls <suite-file>
rundown scenario-suite show <suite-file> <case>
rundown scenario-suite run <suite-file> <case>
rundown scenario-suite run <suite-file> --all      # Run all cases
rundown scenario-suite run <suite-file> --quiet    # Suppress output
```

Implementation notes:

- `scenario-suite run` executes each case through the same command sequence
  runner as `scenario run`, so JSON warnings emitted by commands must be
  declared in `expect.warnings`; any unasserted warning fails the case even when
  the underlying command exits 0.
- Delegation tokens are captured from `rundown delegate` JSON responses and from
  `step_entered.delegateFrontier` auto-issued tokens. `${TOKEN}` expands to the
  first captured token, `${TOKEN_2}` to the second, and so on.
- Claim ids are captured from `rundown claim` JSON responses. `${CLAIM_ID}`
  expands to the first captured claim id, `${CLAIM_ID_2}` to the second, and so
  on.

#### Sibling CLIs: `rdpath` and `rdx`

Two companion CLIs ship alongside `rundown`:

- **`rdpath`** — Path assembly tool for date-prefixed filenames and
  context-scoped paths. See [docs/reference/rdpath.md](rdpath.md).
- **`rdx`** — JSON-to-Markdown renderer with optional schema validation. See
  [docs/reference/rdx.md](rdx.md).

### Delegation Commands

| Command                                                                   | Description                                                                       |
| ------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| `rundown delegate`                                                        | Infer both child runbook and substep from runbook state                           |
| `rundown delegate --step <id>`                                            | Infer child runbook from the DELEGATE substep's `runbooks:` field                 |
| `rundown delegate <runbook> --step <id>`                                  | Delegate substep to an explicit child runbook                                     |
| `rundown delegate <runbook> --step <id> --input key=value`                | Delegate with variables (`--input`/`--input-json`/`--input-file`, all repeatable) |
| `rundown delegate --retry <token>`                                        | Retry a delegation: cancel and re-issue with a fresh token                        |
| `rundown delegate --retry --step <id>`                                    | Retry the delegation on a substep                                                 |
| `rundown delegate --retry --step <id> --index <n>`                        | Retry a delegation within a FOR iteration                                         |
| `rundown delegate --retry`                                                | Retry the delegation inferred from the active substep                             |
| `rundown delegate --retry --step <id> --input key=value`                  | Retry with variable overrides                                                     |
| `rundown claim <token>`                                                   | Claim a delegation token, launch child, and return `claim_id`                     |
| `rundown claim <token> --input key=value`                                 | Claim with variables (`--input`/`--input-json`/`--input-file`, all repeatable)    |
| `rundown pass --claim-capability <claim_capability>`                      | Complete a claimed child with PASS                                                |
| `rundown fail --claim-capability <claim_capability>`                      | Complete a claimed child with FAIL                                                |
| `rundown status --claim-id <claim_id>`                                    | Inspect a claimed child runbook                                                   |
| `rundown collect --claim-capability <claim_capability>`                   | Collect delegated results for a claimed child scope                               |
| `rundown goto <step> --claim-capability <claim_capability>`               | Jump within a claimed child runbook                                               |
| `rundown stash --claim-id <claim_id>`                                     | Stash a claimed child runbook while preserving the claim record                   |
| `rundown pop --claim-id <claim_id>`                                       | Restore a stashed claimed child runbook                                           |
| `rundown stop --claim-capability <claim_capability>`                      | Stop a claimed child runbook                                                      |
| `rundown complete --claim-capability <claim_capability>`                  | Complete a claimed child runbook                                                  |
| `rundown delegate --step <id> --run-capability <run_capability>`          | Orchestrator lane: delegate on a delegation-exposed run you control               |
| `rundown collect --run-capability <run_capability>`                       | Orchestrator lane: aggregate delegated results for the run you control            |
| `rundown pass --run-capability <run_capability>`                          | Orchestrator lane: advance the run you control                                    |
| `rundown fail --run-capability <run_capability>`                          | Orchestrator lane: record a failing advance on the run you control                |
| `rundown goto <step> --run-capability <run_capability>`                   | Orchestrator lane: jump within the run you control (run-navigation policy gate)   |
| `rundown complete --run-capability <run_capability>`                      | Orchestrator lane: complete the run you control                                   |
| `rundown stop --run-capability <run_capability>`                          | Orchestrator lane: stop the run you control                                       |
| `rundown abort <token>`                                                   | Cancel a delegation token                                                         |
| `rundown abort <token> --force`                                           | Cancel a claimed delegation                                                       |
| `rundown abort --claim-id <claim_id> --operator-override abandoned-child` | Release an abandoned claim record without recording a child outcome               |

Delegation semantics:

- Manual delegation requires an authored delegation target: the target substep
  must carry `- DELEGATE` directly or inherit it from step-level `- DELEGATE`,
  and it must have an authored runbook reference. Plain runbook-list substeps
  without `- DELEGATE` are inline launch targets, not manual delegation targets.
- `delegate` infers the child runbook and target substep from runbook state only
  when the active frontier is an authored DELEGATE target. The `[runbook]`
  positional and `--step` are both optional and inferred when omitted: with
  neither, both are inferred via the active delegated substep; with `--step`
  only, the runbook is read from the delegated substep's `runbooks:` field; with
  the runbook only, the substep is inferred.
- `delegate <runbook> --step <id>` does not override the authored target. The
  requested runbook must match one of the substep's authored runbook references;
  otherwise the command fails without minting or exposing a token.
- `delegate` is **idempotent** over a pending (unclaimed) delegation in every
  form — bare, `--step`, and positional `<runbook>` alike echo the in-flight
  token as `action: "already-delegated"` (the raw token IS re-printed, so a lost
  token is recoverable while the delegation is pending). Naming a **different**
  runbook than the in-flight one fails with RD-804 (`DELEGATION_ALREADY_EXISTS`)
  without minting or exposing a token.
- Targeting a substep whose delegation is **claimed** by a live child fails with
  RD-811 (`DELEGATION_ALREADY_CLAIMED`) — a fresh mint would orphan the running
  child. Recover explicitly with `rundown abort <token> --force` then
  re-delegate, or `rundown delegate --retry`.
- `rundown delegate --retry <token>` refuses a live claimed child, but can
  supersede a terminal linked child and mint a fresh token. The target is
  resolved from a token positional, from `--step` (optionally with `--index` for
  a FOR iteration), or inferred from the active substep.
  `--input`/`--input-json`/`--input-file` supply variable overrides on the
  re-issued delegation.
- `rundown abort <token> --force` cancels an active claimed child as fail. When
  the linked child is already terminal or already reported, it performs cleanup
  without recording a duplicate fail.
- If a child process is abandoned and cannot present its claim capability, an
  operator may release only the claim record with
  `rundown abort --claim-id <claim_id> --operator-override abandoned-child`.
  This recovery form does not synthesize PASS or FAIL; it only removes the
  parent-side claim routing record.
- `claim` uses the delegation token (printed by `delegate`) to launch the child
  runbook and returns a stable `claim_id`.
- Child runbook uses `rundown pass --claim-capability <claim_capability>` /
  `rundown fail --claim-capability <claim_capability>` to report its outcome.
  Other claim-targeted lifecycle commands use the same explicit child routing.
- Orchestrator lane: on a delegation-exposed run every mutating command
  (`delegate`, `collect`, `pass`, `fail`, `goto`, `complete`, `stop`) must name
  the run you control with `--run-capability <run_capability>`; the bare form is
  refused with `ACTOR_CONTEXT_REQUIRED`. The run id is printed by `rundown run`
  at start and carried as `runbookId` on every event. The refusal remediation
  names both lanes and never echoes the target run id.
- Completion routing is frame + entry aware (`frame + entry + substep`) to
  prevent stale re-entry completions from being applied.
- Claimed children are routed by claim id, not by the shared stack.
  `rundown claim <token>` records the claimed child run id under a generated
  `rdclm_...` handle; later commands use `--claim-capability <claim_capability>`
  to resolve that exact child.
- Re-claiming the same delegated child refreshes and returns the existing claim
  id.
- Claimed children are never pushed to `defaultStack`, so parallel delegated
  siblings cannot be accidentally targeted by plain stack commands.
- If a claim record points at missing, terminal, stale, or unlinked state,
  commands fail closed instead of falling back to the shared stack in the same
  invocation.

---

## Common Tasks

These examples assume a **standalone run** (no delegation activity), so the bare
transition forms apply. On a delegation-exposed run the bare form is refused
with `ACTOR_CONTEXT_REQUIRED`; see [Delegation Patterns](#delegation-patterns)
for the `--run-capability <run_capability>` (orchestrator) and
`--claim-capability <claim_capability>` (child) targeted forms.

### Task: Run a Simple Sequential Runbook

```bash
# Start the runbook
rundown run myrunbook.runbook.md

# After completing each step, signal the outcome
rundown pass    # or rundown yes, rundown ok
rundown fail    # Step failed, apply FAIL transition
```

### Task: Check Runbook Status

```bash
rundown status
```

Output shows:

- Current runbook file
- State file location
- Current action location (`At`) and optional loop scope (`For`)
- Last action taken

### Task: Jump to a Specific Step

```bash
rundown goto 3       # Jump to step 3
rundown goto 2.1     # Jump to substep 1 of step 2
```

### Task: Pause and Resume a Runbook

```bash
# Pause (state preserved, enforcement paused)
rundown stash

# Do untracked work...

# Resume
rundown pop
```

### Task: List Runbooks

```bash
# List active/running runbooks
rundown ls

# List all available runbook files
rundown ls --all

# Filter by tags
rundown ls --all --tags tdd,review
```

### Task: Validate a Runbook Before Running

```bash
rundown check myrunbook.runbook.md
```

Output: `PASS: N steps` or `FAIL: error details`

### Task: Clean Up Old Runbook State

```bash
# Preview what would be removed
rundown prune --dry-run

# Remove completed + stopped runbook state (default)
rundown prune

# Remove only completed runbook state
rundown prune --completed

# Remove only stopped (aborted/failed) runbook state
rundown prune --stopped

# Remove all state
rundown prune --all
```

---

## Delegation Patterns

> **See also:**
> [docs/guides/agent-orchestration.md](../guides/agent-orchestration.md) for
> subagent delegation workflow, context file discovery, and delegation
> completion.

### Pattern 1: Orchestrator Control

Main agent runs runbook, dispatches subagents for substeps.

**Runbook structure:**

```markdown
## 2. Execute batch
- PASS ALL CONTINUE
- FAIL ANY GOTO 4

### 2.1 Process item
- DELEGATE
- task.runbook.md
```

**Command sequence:**

```bash
# 1. Main agent starts parent runbook, capturing the run id it prints
#    (also carried as runbookId on every subsequent event)
rundown run runbook.runbook.md

# 2. At substep, main agent delegates to child runbook, naming the run it controls
rundown delegate task.runbook.md --step 2.1 --run-capability <run_capability>

# 3. Subagent claims the delegation token
rundown claim <token>

# 4. Subagent works through child runbook...

# 5. Subagent reports result using the claim_capability returned by rundown claim
rundown pass --claim-capability <claim_capability>    # or: rundown fail --claim-capability <claim_capability>

# 6. Main agent advances its own run with --run once the child has reported
rundown pass --run-capability <run_capability>             # or: rundown collect --run-capability <run_capability>
```

**Key points:**

- Manual `delegate` targets must be authored with `- DELEGATE`; a plain
  runbook-list substep launches inline instead
- `delegate` infers the child runbook and target substep from delegated runbook
  state; the runbook positional and `--step` are optional and inferred when
  omitted
- The delegation token printed by `delegate` is passed to `claim` by the
  subagent
- The `claim_id` printed by `claim` is passed to every child-targeting command
- Orchestrator lane: capture the run id from `rundown run` (echoed as
  `runbookId` on every event) and pass `--run-capability <run_capability>` on
  every orchestrator mutation (`delegate`, `collect`, `pass`, `fail`, `goto`);
  the bare form is refused with `ACTOR_CONTEXT_REQUIRED` on a delegation-exposed
  run
- Child uses `rundown pass --claim-capability <claim_capability>` /
  `rundown fail --claim-capability <claim_capability>`
- Completions are validated against frame + entry identity; stale completions
  from prior re-entry are rejected
- Valid completions are recorded and drained in deterministic substep order
  before step-level transition

### Pattern 2: Agent-Controlled Branching

Agent decides next action based on context.

```markdown
## 5. Check remaining
- PASS CONTINUE
- FAIL STOP

Check TodoWrite for remaining items.

If more remain: `rundown goto 3`
If complete: `rundown pass`
```

Agent reads step, evaluates condition, runs appropriate CLI command. On a
delegation-exposed run these become
`rundown goto 3 --run-capability <run_capability>` and
`rundown pass --run-capability <run_capability>`; the bare forms shown apply to
a standalone run.

---

## Output Format

Output formatting is implemented in
`packages/cli/src/services/output-emitter.ts` and
`packages/cli/src/helpers/table-formatter.ts`.

### Standard Output Structure

```text
File:     runbook.runbook.md
State:    .rundown/runs/rd_0123456789abcdef0123456789abcdef.json
Action:   START
At:       1

Step description here...

$ npm test

-----
Action:   CONTINUE
From:     1.1.1
Result:   PASS
For:      2/5
At:       1.2.1

Next step description...

Runbook:  COMPLETE
```

### Table Output

List commands (`rundown ls`, `rundown scenario ls`) use aligned tables following
Linux CLI conventions:

| Convention         | Standard                                  |
| ------------------ | ----------------------------------------- |
| **Headers**        | UPPERCASE, first row, no decorative lines |
| **Alignment**      | Left for text, right for numbers          |
| **Separator**      | 2 spaces between columns                  |
| **Last column**    | Extends to end (no padding)               |
| **Empty values**   | Empty string                              |
| **Machine output** | JSON output by default                    |

Example (`rundown ls --all`):

```text
NAME           SOURCE   DESCRIPTION                    TAGS
retry-success  bundled  Tests RETRY before exhaustion  retry, auto-exec
simple         project  Basic two-step runbook
```

Example (`rundown scenario ls`):

```text
NAME              EXPECTED  DESCRIPTION                   TAGS
completed         COMPLETE  Step passes on first attempt
retry-exhaustion  STOP      Retries exhausted, stops
```

### Detail Views

Single-item display commands (`rundown scenario show`) use aligned key-value
format:

| Convention        | Standard                                  |
| ----------------- | ----------------------------------------- |
| **Key alignment** | Pad to longest key + `:`                  |
| **Format**        | `Key:` followed by spaces to align values |
| **Nested items**  | Indent 2 spaces under label               |

Example (`rundown scenario show`):

```text
Name:        completed
Description: Step passes on first attempt
Expected:    COMPLETE
Commands:
  $ rundown run --prompted retry-success.runbook.md
  $ rundown pass
```

### Command Execution Output

Commands that execute operations (`rundown scenario run`) use a
Scenario/Execution/Result structure:

```text
Scenario: scenario-name

---
$ rundown run --prompted file.runbook.md
$ rundown pass

Scenario: COMPLETE
```

### Key Elements

| Element    | Description                                                 |
| ---------- | ----------------------------------------------------------- |
| `File:`    | Runbook file path                                           |
| `State:`   | State JSON file path                                        |
| `Action:`  | Last action (START, CONTINUE, GOTO, RETRY, COMPLETE, STOP)  |
| `From:`    | Previous step position                                      |
| `Result:`  | PASS or FAIL                                                |
| `For:`     | Loop scope (`index/end` or `index/?`) when in FOR execution |
| `At:`      | Current execution path (display path, e.g. `1.2.1`)         |
| `$`        | Command being executed                                      |
| `---`      | Separator between scenario commands                         |
| `Runbook:` | Runbook terminal state (COMPLETE, STOPPED, STASHED)         |

JSON output compatibility:

- Existing position fields (`current`, `substep`, `total`) are preserved.
- Loop/location-aware fields are additive and optional: `position.at`,
  `position.for.index`, `position.for.end`.
- `targetAt` is derived at output boundaries from canonical target identity
  fields.

---

## Troubleshooting and Error Handling

### Common Errors and Resolutions

| Error                                       | Cause                                                                    | Resolution                                                                                                                      |
| ------------------------------------------- | ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------- |
| "No active runbook"                         | No runbook in stack                                                      | Run `rundown run <file>`                                                                                                        |
| "Runbook file not found"                    | Missing runbook                                                          | Check file path                                                                                                                 |
| "Step N does not exist"                     | Invalid GOTO target                                                      | Check step numbers                                                                                                              |
| "Invalid step target"                       | Bad goto format                                                          | Use "N" or "N.M"                                                                                                                |
| "FOR loop references undefined data source" | Sourced FOR clause without matching source                               | Define source via --input-json, config.yaml, or --input-file                                                                    |
| "File drift detected"                       | Data file changed during iteration                                       | Ensure file stability or restart runbook                                                                                        |
| `ACTOR_CONTEXT_REQUIRED`                    | Bare mutating command on a delegation-exposed run                        | Name your lane: `--run-capability <run_capability>` (orchestrator) or `--claim-capability <claim_capability>` (delegated child) |
| `RUN_TARGET_UNAVAILABLE`                    | `--run` target is not a running member of this session's stack           | Use a run id from the active session stack (claimed children are never stack members — target them with `--claim-id`)           |
| `INVALID_RUN_ID`                            | Malformed `--run` value                                                  | Supply a valid run id — `rd_<32 hex characters>`                                                                                |
| `COLLECT_REQUIRES_ORCHESTRATOR`             | `rundown collect` without an actor controlling the target delegating run | Run `collect` as the orchestrator of the delegating run (`--run-capability <run_capability>`)                                   |

### State Recovery

If state becomes corrupted:

1. `rundown ls` - Check active runbooks
2. `rundown stop [message]` - Clear active runbook
3. `rundown prune --all` - Remove all state
4. `rundown run <file>` - Restart fresh

---

## Integration with Claude Code

See [docs/guides/agent-orchestration.md](../guides/agent-orchestration.md) for
context file discovery and subagent delegation.

Active runbook prompt auto-injects into Claude conversations via hooks. Both
runbook state and session tracking survive context clears, session restarts, and
agent handoffs.

---

## CLI Quick Reference

```bash
# Lifecycle
rundown run <file>           # Start runbook
rundown stop [message]       # Abort runbook with optional message
rundown complete [message]   # Force early completion (auto-complete on final step)

# Transitions (bare forms below are standalone-run only; a delegation-exposed
# run refuses them with ACTOR_CONTEXT_REQUIRED — name your lane instead)
rundown pass                 # Step succeeded (aliases: yes, ok)
rundown fail                 # Step failed (alias: no)
rundown goto <N>             # Jump to step N
rundown goto <N.M>           # Jump to substep N.M
rundown pass --run-capability <run_capability>    # Orchestrator advance (delegation-exposed run)
rundown collect --run-capability <run_capability> # Orchestrator aggregates delegated results
rundown goto <N> --run-capability <run_capability># Orchestrator jump (run-navigation policy gate)

# Status
rundown status               # Show current state
rundown ls                   # List active runbooks
rundown ls --all             # List available runbooks

# Enforcement
rundown stash                # Pause enforcement
rundown pop                  # Resume enforcement

# Maintenance
rundown check <file>         # Validate runbook
rundown resolve <file>       # Resolve and validate variables/data sources
rundown prune                # Clean up state

# Testing and utilities
rundown echo [command...]              # Test helper (configurable pass/fail)
rundown prompt <content>               # Output content in markdown fences
rundown scenario ls <file>             # List runbook scenarios
rundown scenario show <file> <name>    # Show scenario details
rundown scenario run <file> <name>     # Execute a scenario
rundown scenario-suite ls <suite>      # List scenario-suite cases
rundown scenario-suite run <suite>     # Execute suite case(s)

# Sibling CLIs
rdpath --dir <path>          # Path assembly tool (see docs/reference/rdpath.md)
rdx <file>                   # Render JSON to Markdown (see docs/reference/rdx.md)

# Delegation (orchestrator commands on a delegation-exposed run carry
# --run-capability <run_capability>; capture the capability from `rundown run`)
rundown delegate --step <id> --run-capability <run_capability>         # Delegate on the run you control
rundown delegate <runbook> --step <id> --run-capability <run_capability>  # Explicit child runbook
rundown delegate --retry <token> --run-capability <run_capability>     # Retry: cancel and re-issue
rundown collect --run-capability <run_capability>            # Aggregate delegated results
rundown claim <token>                   # Claim delegation token and return claim_id
rundown status --claim-id <claim_id>    # Inspect claimed child
rundown pass --claim-capability <claim_capability>      # Complete claimed child with PASS
rundown fail --claim-capability <claim_capability>      # Complete claimed child with FAIL
rundown goto <step> --claim-capability <claim_capability> # Jump within claimed child
rundown stash --claim-id <claim_id>     # Stash claimed child
rundown pop --claim-id <claim_id>       # Restore stashed claimed child
rundown collect --claim-capability <claim_capability>   # Collect delegated child results
rundown stop --claim-capability <claim_capability>      # Stop claimed child
rundown complete --claim-capability <claim_capability>  # Complete claimed child
rundown abort <token>                   # Cancel delegation token
rundown abort --claim-id <claim_id> --operator-override abandoned-child
```
