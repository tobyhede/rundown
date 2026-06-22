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

The `rd` command is an alias for `rundown`.

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

`rd ls --all` lists discoverable runbooks with a `SOURCE` column indicating
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

Rundown enforces a security policy layer to control what commands runbooks can
execute. See [docs/reference/security.md](security.md) for full default policy
details, including command allow/block/prompt behavior, sandbox-on-by-default
enforcement, and the default write allowlist.

### Security Quick Reference

| Flag                    | Effect                                                                                   |
| ----------------------- | ---------------------------------------------------------------------------------------- |
| `--allow-run <cmds>`    | Allow specific commands (comma-separated)                                                |
| `--allow-read <paths>`  | Allow reading specific paths                                                             |
| `--allow-write <paths>` | Allow writing to specific paths                                                          |
| `--allow-env <vars>`    | Allow specific environment variables                                                     |
| `--allow-all`           | Bypass all policy checks                                                                 |
| `--deny-all`            | Block all commands not explicitly allowed                                                |
| `-y, --yes`             | Auto-approve prompts                                                                     |
| `--non-interactive`     | CI mode (auto-deny unlisted commands)                                                    |
| `--policy <file>`       | Use custom policy file                                                                   |
| `--trust-js-policy`     | Trust an explicitly selected JS policy file and helper modules declared by policy config |
| `--helpers <paths>`     | Helper module paths to load (comma-separated, relative to project root)                  |
| `--sandbox`             | Enable OS-level filesystem sandbox (default)                                             |
| `--no-sandbox`          | Disable sandbox enforcement; the explicit opt-out when the sandbox is unavailable        |
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
and removes it from the active session stack.

#### `rundown complete [message]` - Force Early Completion

Manually complete a runbook before reaching the final step.

**Note:** Runbooks auto-complete when the final step's PASS transition executes
and there are no more steps. This command is only needed for early exit
scenarios.

```bash
rundown complete                            # Force completion from current step
rundown complete "Skipping remaining steps" # Complete with message
```

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
```

**Aliases:** `rundown yes`, `rundown ok`

**Flags:**

- `--step <stepId>` — Target a specific substep (not the currently active one).
- `--index <number>` — FOR loop iteration to target (requires `--step`).

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
```

**Alias:** `rundown no`

**Flags:**

- `--step <stepId>` — Target a specific substep (not the currently active one).
- `--index <number>` — FOR loop iteration to target (requires `--step`).

**Behavior:**

1. Send FAIL event to XState
2. Evaluate FAIL transition (may trigger RETRY)
3. Execute resulting action
4. Print action taken

For RETRY transitions:

- If `retryCount < max`: increment count, stay in step
- If exhausted: execute fallback action (default: STOP)

#### `rundown goto <step>` - Jump to Step

Navigate directly to a step.

```bash
rundown goto 3                # Jump to step 3
rundown goto 3.1              # Jump to substep 3.1
rundown goto 3 --index 2      # Jump to step 3 and enter FOR iteration 2
```

**Flags:**

- `--index <number>` — For FOR-annotated targets, enter the loop at the
  specified iteration.

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
rd artifact ls                         # List artifact aliases visible in the active run context
rd artifact inspect <Alias-or-uri>      # Return the full artifact record for an alias or manifest-backed exact URI
rd artifact path <Alias-or-uri>         # JSON: full artifact record; --text: local path only
rd artifact uri <Alias>                 # JSON: full artifact record; --text: canonical artifact URI only
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
```

`--input`, `--input-json`, and `--input-file` are all repeatable.

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
- Delegation tokens are captured from `rd delegate` JSON responses and from
  `step_entered.delegateFrontier` auto-issued tokens. `${TOKEN}` expands to the
  first captured token, `${TOKEN_2}` to the second, and so on.
- Claim ids are captured from `rd claim` JSON responses. `${CLAIM_ID}` expands
  to the first captured claim id, `${CLAIM_ID_2}` to the second, and so on.
- `--input-file` dependencies are copied by directory. Scenario execution copies
  the entire containing directory for each relative `--input-file` path so YAML
  files that contain sibling `file:` references keep working. Absolute paths and
  `..` traversal are rejected.

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
- Delegation tokens are captured from `rd delegate` JSON responses and from
  `step_entered.delegateFrontier` auto-issued tokens. `${TOKEN}` expands to the
  first captured token, `${TOKEN_2}` to the second, and so on.
- Claim ids are captured from `rd claim` JSON responses. `${CLAIM_ID}` expands
  to the first captured claim id, `${CLAIM_ID_2}` to the second, and so on.

#### Sibling CLIs: `rdpath` and `rdx`

Two companion CLIs ship alongside `rundown`:

- **`rdpath`** — Path assembly tool for date-prefixed filenames and
  context-scoped paths. See [docs/reference/rdpath.md](rdpath.md).
- **`rdx`** — JSON-to-Markdown renderer with optional schema validation. See
  [docs/reference/rdx.md](rdx.md).

### Delegation Commands

| Command                                               | Description                                                                       |
| ----------------------------------------------------- | --------------------------------------------------------------------------------- |
| `rd delegate`                                         | Infer both child runbook and substep from runbook state                           |
| `rd delegate --step <id>`                             | Infer child runbook from the substep's `runbooks:` field                          |
| `rd delegate <runbook> --step <id>`                   | Delegate substep to an explicit child runbook                                     |
| `rd delegate <runbook> --step <id> --input key=value` | Delegate with variables (`--input`/`--input-json`/`--input-file`, all repeatable) |
| `rd delegate --retry <token>`                         | Retry a delegation: cancel and re-issue with a fresh token                        |
| `rd delegate --retry --step <id>`                     | Retry the delegation on a substep                                                 |
| `rd delegate --retry --step <id> --index <n>`         | Retry a delegation within a FOR iteration                                         |
| `rd delegate --retry`                                 | Retry the delegation inferred from the active substep                             |
| `rd delegate --retry --step <id> --input key=value`   | Retry with variable overrides                                                     |
| `rd claim <token>`                                    | Claim a delegation token, launch child, and return `claim_id`                     |
| `rd claim <token> --input key=value`                  | Claim with variables (`--input`/`--input-json`/`--input-file`, all repeatable)    |
| `rd pass --claim-id <claim_id>`                       | Complete a claimed child with PASS                                                |
| `rd fail --claim-id <claim_id>`                       | Complete a claimed child with FAIL                                                |
| `rd status --claim-id <claim_id>`                     | Inspect a claimed child runbook                                                   |
| `rd collect --claim-id <claim_id>`                    | Collect delegated results for a claimed child scope                               |
| `rd goto <step> --claim-id <claim_id>`                | Jump within a claimed child runbook                                               |
| `rd stash --claim-id <claim_id>`                      | Stash a claimed child runbook while preserving the claim record                   |
| `rd pop --claim-id <claim_id>`                        | Restore a stashed claimed child runbook                                           |
| `rd stop --claim-id <claim_id>`                       | Stop a claimed child runbook                                                      |
| `rd complete --claim-id <claim_id>`                   | Complete a claimed child runbook                                                  |
| `rd abort <token>`                                    | Cancel a delegation token                                                         |
| `rd abort <token> --force`                            | Cancel a claimed delegation                                                       |

Delegation semantics:

- `delegate` infers the child runbook and target substep from runbook state. The
  `[runbook]` positional and `--step` are both optional and inferred when
  omitted: with neither, both are inferred via the active substep; with `--step`
  only, the runbook is read from the substep's `runbooks:` field; with the
  runbook only, the substep is inferred.
- `delegate --retry` cancels an existing delegation and re-issues it with a
  fresh token. The target is resolved from a token positional, from `--step`
  (optionally with `--index` for a FOR iteration), or inferred from the active
  substep. `--input`/`--input-json`/`--input-file` supply variable overrides on
  the re-issued delegation.
- `claim` uses the delegation token (printed by `delegate`) to launch the child
  runbook and returns a stable `claim_id`.
- Child runbook uses `rd pass --claim-id <claim_id>` /
  `rd fail --claim-id <claim_id>` to report its outcome. Other claim-targeted
  lifecycle commands use the same explicit child routing.
- Completion routing is frame + entry aware (`frame + entry + substep`) to
  prevent stale re-entry completions from being applied.
- Claimed children are routed by claim id, not by the shared stack.
  `rd claim <token>` records the claimed child run id under a generated
  `rdclm_...` handle; later commands use `--claim-id <claim_id>` to resolve that
  exact child.
- Re-claiming the same delegated child refreshes and returns the existing claim
  id.
- Claimed children are never pushed to `defaultStack`, so parallel delegated
  siblings cannot be accidentally targeted by plain stack commands.
- If a claim record points at missing, terminal, stale, or unlinked state,
  commands fail closed instead of falling back to the shared stack in the same
  invocation.

---

## Common Tasks

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
  - task.runbook.md
```

**Command sequence:**

```bash
# 1. Main agent starts parent runbook
rd run runbook.runbook.md

# 2. At substep, main agent delegates to child runbook
rd delegate task.runbook.md --step 2.1

# 3. Subagent claims the delegation token
rd claim <token>

# 4. Subagent works through child runbook...

# 5. Subagent reports result using the claim_id returned by rd claim
rd pass --claim-id <claim_id>    # or: rd fail --claim-id <claim_id>
```

**Key points:**

- `delegate` infers the child runbook and target substep from runbook state; the
  runbook positional and `--step` are optional and inferred when omitted
- The delegation token printed by `delegate` is passed to `claim` by the
  subagent
- The `claim_id` printed by `claim` is passed to every child-targeting command
- Child uses `rd pass --claim-id <claim_id>` / `rd fail --claim-id <claim_id>`
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

Agent reads step, evaluates condition, runs appropriate CLI command.

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

List commands (`rd ls`, `rd scenario ls`) use aligned tables following Linux CLI
conventions:

| Convention         | Standard                                  |
| ------------------ | ----------------------------------------- |
| **Headers**        | UPPERCASE, first row, no decorative lines |
| **Alignment**      | Left for text, right for numbers          |
| **Separator**      | 2 spaces between columns                  |
| **Last column**    | Extends to end (no padding)               |
| **Empty values**   | Empty string                              |
| **Machine output** | JSON output by default                    |

Example (`rd ls --all`):

```text
NAME           SOURCE   DESCRIPTION                    TAGS
retry-success  bundled  Tests RETRY before exhaustion  retry, auto-exec
simple         project  Basic two-step runbook
```

Example (`rd scenario ls`):

```text
NAME              EXPECTED  DESCRIPTION                   TAGS
completed         COMPLETE  Step passes on first attempt
retry-exhaustion  STOP      Retries exhausted, stops
```

### Detail Views

Single-item display commands (`rd scenario show`) use aligned key-value format:

| Convention        | Standard                                  |
| ----------------- | ----------------------------------------- |
| **Key alignment** | Pad to longest key + `:`                  |
| **Format**        | `Key:` followed by spaces to align values |
| **Nested items**  | Indent 2 spaces under label               |

Example (`rd scenario show`):

```text
Name:        completed
Description: Step passes on first attempt
Expected:    COMPLETE
Commands:
  $ rd run --prompted retry-success.runbook.md
  $ rd pass
```

### Command Execution Output

Commands that execute operations (`rd scenario run`) use a
Scenario/Execution/Result structure:

```text
Scenario: scenario-name

---
$ rd run --prompted file.runbook.md
$ rd pass

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

| Error                                       | Cause                                      | Resolution                                                   |
| ------------------------------------------- | ------------------------------------------ | ------------------------------------------------------------ |
| "No active runbook"                         | No runbook in stack                        | Run `rundown run <file>`                                     |
| "Runbook file not found"                    | Missing runbook                            | Check file path                                              |
| "Step N does not exist"                     | Invalid GOTO target                        | Check step numbers                                           |
| "Invalid step target"                       | Bad goto format                            | Use "N" or "N.M"                                             |
| "FOR loop references undefined data source" | Sourced FOR clause without matching source | Define source via --input-json, config.yaml, or --input-file |
| "File drift detected"                       | Data file changed during iteration         | Ensure file stability or restart runbook                     |

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

# Transitions
rundown pass                 # Step succeeded (aliases: yes, ok)
rundown fail                 # Step failed (alias: no)
rundown goto <N>             # Jump to step N
rundown goto <N.M>           # Jump to substep N.M

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

# Delegation
rd delegate                        # Infer child runbook + substep from state
rd delegate --step <id>            # Infer child runbook from substep
rd delegate <runbook> --step <id>  # Delegate substep to explicit child runbook
rd delegate --retry <token>        # Retry delegation: cancel and re-issue
rd delegate --retry --step <id>    # Retry delegation on a substep
rd claim <token>                   # Claim delegation token and return claim_id
rd status --claim-id <claim_id>    # Inspect claimed child
rd pass --claim-id <claim_id>      # Complete claimed child with PASS
rd fail --claim-id <claim_id>      # Complete claimed child with FAIL
rd goto <step> --claim-id <claim_id> # Jump within claimed child
rd stash --claim-id <claim_id>     # Stash claimed child
rd pop --claim-id <claim_id>       # Restore stashed claimed child
rd collect --claim-id <claim_id>   # Collect delegated child results
rd stop --claim-id <claim_id>      # Stop claimed child
rd complete --claim-id <claim_id>  # Complete claimed child
rd abort <token>                   # Cancel delegation token
```
