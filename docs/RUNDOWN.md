# Rundown CLI Guide and Reference

This document provides a comprehensive guide and reference for the Rundown CLI (`rundown`), explaining how it executes runbooks defined in the Rundown format, tracks runbook state, manages execution, and dispatches subagents.

**For syntax and format details, see:**
- [SPEC.md](./SPEC.md) - Rundown specification
- [FORMAT.md](./FORMAT.md) - Format grammar and expansion rules
- [AGENT-ORCHESTRATION.md](./AGENT-ORCHESTRATION.md) - Agent orchestration models and patterns

---

## Table of Contents

- [Architecture Overview](#architecture-overview)
- [Installation](#installation)
- [Quick Start](#quick-start)
- [How It Works](#how-it-works)
  - [Execution Model](#execution-model)
  - [State Machine](#state-machine)
  - [Command Execution](#command-execution)
  - [FOR Loops](#for-loops)
- [State Persistence](#state-persistence)
  - [File Locations](#file-locations)
  - [Session Structure](#session-structure)
  - [Runbook State Structure](#runbook-state-structure)
- [Security Policy](#security-policy)
  - [Default Behavior](#default-behavior)
  - [Quick Reference](#quick-reference)
- [CLI Commands](#cli-commands)
  - [Runbook Lifecycle](#runbook-lifecycle)
  - [State Transitions](#state-transitions)
  - [Status Commands](#status-commands)
  - [Enforcement Control](#enforcement-control)
  - [Validation](#validation)
  - [Maintenance](#maintenance)
  - [Subagent Commands](#subagent-commands)
- [Common Tasks](#common-tasks)
- [Subagent Dispatch Patterns](#subagent-dispatch-patterns)
  - [Pattern 1: Orchestrator Control](#pattern-1-orchestrator-control)
  - [Pattern 2: Agent-Controlled Branching](#pattern-2-agent-controlled-branching)
- [Output Format](#output-format)
  - [Standard Output Structure](#standard-output-structure)
  - [Key Elements](#key-elements)
- [Troubleshooting and Error Handling](#troubleshooting-and-error-handling)
  - [Common Errors and Resolutions](#common-errors-and-resolutions)
  - [State Recovery](#state-recovery)
- [Integration with Claude Code](#integration-with-claude-code)
  - [Context Injection](#context-injection)
  - [Session Persistence](#session-persistence)
- [Quick Reference](#quick-reference)

---

## Architecture Overview

The Rundown system separates concerns into three layers:

| Layer | Component | Responsibility |
|-------|-----------|----------------|
| **Format** | `.runbook.md` files | Runbook definition (steps, transitions, commands) |
| **State Machine** | XState-compiled machine | State transitions and guards |
| **Persistence** | JSON files | Runbook state survives context clears |
| **Iteration** | ForIterationService | Per-iteration data source value resolution |

The CLI is an orchestration and control interface. Claude executes the actual work.

```
[Runbook File] --> [Parser] --> [XState Machine] --> [State Manager]
                                       ^                    |
                                       |                    v
                              [CLI Commands] <---- [Persisted JSON]
```

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
rundown run /path/to/project/.claude/rundown/runbooks/simple.runbook.md

# Or from the project root, with runbook in the standard location
rundown run simple.runbook.md
```

The CLI resolves runbook paths in this order:
1. Absolute path (used as-is)
2. Relative to current working directory
3. Relative to `.claude/rundown/runbooks/` in the project root

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

## How It Works

### Execution Model

Rundown separates **runbook definition** from **state tracking**:

| Component | Role |
|-----------|------|
| **Runbook file** | Markdown document defining steps, transitions, and conditions |
| **CLI (`rundown`)** | Tracks runbook state: current step, retry count, variables |
| **Agent (Claude)** | Executes work, uses CLI to report outcomes |

**Key concept:** The CLI tracks which step you are on and what happens when you report PASS or FAIL. For code blocks, it can execute commands automatically. Otherwise, the agent (or user) does the actual work.

### State Machine

The CLI compiles runbooks into an XState state machine. Each step (and substep) becomes a state. Events (`PASS`, `FAIL`, `GOTO`, `RETRY`) trigger transitions.

#### Compilation
Runbooks compile to XState machines at runtime. Steps become states:

| Runbook Element | XState State ID |
|-----------------|-----------------|
| `## 1. Title` | `step::1` |
| `## 2. Title` | `step::2` |
| `### 2.1 Substep` | `step::2::1` |

Terminal states: `COMPLETE`, `STOPPED`

#### Events
The state machine responds to these events:

| Event | Trigger | Effect |
|-------|---------|--------|
| `PASS` | `rundown pass` or command exit 0 | Evaluate PASS transition |
| `FAIL` | `rundown fail` or command exit non-0 | Evaluate FAIL transition |
| `GOTO` | `rundown goto N` or GOTO action | Jump to step N |
| `RETRY` | FAIL + RETRY action | Increment retryCount, stay in state |

#### Transitions
Default transitions when none specified:
```
PASS ALL: CONTINUE
FAIL ANY: STOP
```

Transition evaluation:
1. Check condition (PASS or FAIL)
2. For RETRY: check if `retryCount < max`
3. Execute action (CONTINUE, COMPLETE, STOP, GOTO)

### Command Execution

| Behavior | Triggered By | What Happens |
|----------|-------------|--------------|
| **Automatic** | Step has `bash` or `prompt` code block | CLI runs command, exit code determines PASS/FAIL |
| **Manual** | `--prompted` flag or no code block | CLI waits for manual `rd pass` or `rd fail` |

**Note:** A `prompt` code block becomes an `rd prompt '...'` command that outputs the content wrapped in markdown fences. It executes automatically like `bash` blocks.

#### WebContainer Environment

In WebContainer environments (e.g., StackBlitz), nested process spawning may not work correctly. The CLI includes an internal command dispatcher (`packages/cli/src/services/internal-commands.ts`) that intercepts `rd`/`rundown` commands and executes them directly without spawning a child process.

- `isInternalRdCommand()` detects rd/rundown commands
- `executeRdCommandInternal()` dispatches to internal handlers
- Currently supported: `echo`, `prompt` commands
- Unsupported commands fall back to standard spawn behavior

Example of a step that auto-executes:
````markdown
## 3. Run tests
- PASS: CONTINUE
- FAIL: RETRY 2

```bash
npm test
```
````

Example of a prompted step:
````markdown
## 4. Code review
- PASS: CONTINUE
- FAIL: STOP

Review the implementation for issues.
`rundown pass` if acceptable, `rundown fail` if blocked.
````

### FOR Loops

Steps can iterate their substeps over a numeric range using a FOR annotation. FOR loops are defined in the runbook syntax and the CLI manages loop state automatically.

**Syntax (brief):**

````markdown
## 3. Process batches
- FOR batch IN 1 TO 5
- PASS ALL: CONTINUE
- FAIL ANY: STOP

### 1. Process item
- PASS: CONTINUE
- FAIL: BREAK
````

See [SPEC.md FOR Steps](./SPEC.md#for-steps) for the full grammar and all clause variants.

**FOR clause variants:**

| Syntax | Description |
|--------|-------------|
| `FOR var IN 1 TO N` | Explicit range, named variable |
| `FOR 1 TO N` | Explicit range, no variable |
| `FOR var IN N` | Implicit start (1), named variable |
| `FOR N` | Implicit start (1), no variable |
| `FOR var IN {{ source }}` | All items from data source |
| `FOR var IN 1 TO N OF {{ source }}` | Windowed data source |

**Loop variable expansion:**

The named loop variable and `{{Index}}` are expanded per-iteration:
- `{{Index}}` - Current iteration number (1-based), available inside all FOR substeps
- `{{var}}` - Named loop variable. For numeric ranges, equals the iteration index. For data sources (array/file), holds the current data element.

These are expanded per-iteration, unlike template variables which are expanded once at `rd run` time.

**Iteration semantics:**

Substep transitions control within-iteration flow:

| Action | Effect |
|--------|--------|
| `CONTINUE` | Proceed to next substep (or next iteration if last substep) |
| `NEXT` | Skip remaining substeps, advance to next iteration |
| `BREAK` | Exit the FOR loop; parent step transitions evaluate |
| `STOP` | Halt runbook execution immediately |

Parent FOR step transitions (`PASS ALL`, `FAIL ANY`, etc.) aggregate results across all iterations after the loop completes.

**GOTO AT interaction:**

The `AT` qualifier on GOTO targets specific iterations of a FOR step:

```bash
rundown goto 3        # Jump to FOR step 3 at iteration 1 (restart)
```

In runbook transitions, `GOTO N AT I` enters step N at iteration I. See [GOTO formats](#rundown-goto-step---jump-to-step) for the full table.

**Status display during loops:**

When a FOR loop is active, `rundown status` reflects the current iteration via the `forStack` field in the state file. The step display shows the active step and substep within the loop.

#### Data Sources

FOR loops can iterate over arrays or files instead of numeric ranges.

**Defining sources:**

Sources are defined via `.rundown/config.yaml`, `--var-file`, or `--var` flags. Values are routed based on type:

| Value Pattern | Routing |
|---------------|---------|
| `file:path/to/data.txt` | File source only (not a template var) |
| YAML array `[a, b, c]` | Both: comma-joined in vars, array in sources |
| Multiline YAML string | Both: raw in vars, lines split into array source |
| Scalar string/number | Template vars only (no source created) |

**Example `.rundown/config.yaml`:**
```yaml
environment: staging
items:
  - alpha
  - bravo
  - charlie
log_file: file:data/results.jsonl
```

**Example runbook:**
````markdown
## 2 Process items
- FOR item IN {{ items }}
- PASS ALL: CONTINUE
- FAIL ANY: STOP
### 1 Handle item
- PASS: CONTINUE
- FAIL: BREAK
Handle {{item}} (iteration {{Index}}).
````

**File formats:**

| Extension | Format | Parsing |
|-----------|--------|---------|
| `.jsonl` | JSON Lines | One JSON value per line (string, number, boolean, null, array, or object) |
| All others | Plain text | One value per non-empty line |

**JSONL semantics:** Each `.jsonl` line is parsed as a JSON value. When the loop variable holds a parsed JSON object, dotted field access is supported in templates (e.g., `{{item.name}}`). Using `{{item}}` alone renders the serialized JSON string. Users who need raw line strings should use a text source (e.g., `.txt`) instead of `.jsonl`.

**Open-ended iteration:** `FOR item IN {{ source }}` iterates until the source is exhausted, capped at 10,000 iterations.

**Windowed iteration:** `FOR item IN 3 TO 7 OF {{ source }}` reads only items at positions 3 through 7.

**Drift detection:** File sources record a snapshot (size, mtime, SHA-256 fingerprint) at first access. On resume, the snapshot is validated — if the file changed, execution fails with a drift error. Fingerprint comparison allows harmless mtime changes (e.g., backup tools) to pass.

**Validation:** The CLI validates that all sourced FOR clauses reference defined data sources. Missing sources produce: `FOR loop references undefined data source "{{name}}"`.

---

## State Persistence

### File Locations

| Path | Purpose |
|------|---------|
| `.claude/rundown/runs/` | Runbook state files (`wf-YYYY-MM-DD-xxxxx.json`) |
| `.claude/rundown/session.json` | Active runbook tracking, stash, agent stacks |
| `.claude/rundown/runbooks/` | Runbook source files (discovered for `rundown ls --all`) |

### Session Structure

The session tracks which runbooks are active using a **stack-based model**:

```json
{
  "stacks": {
    "agent-123": ["wf-2024-01-07-abc123"]
  },
  "defaultStack": ["wf-2024-01-07-xyz789"],
  "stashedRunbookId": null
}
```

- **defaultStack**: Main runbook stack (no agent ID)
- **stacks**: Per-agent runbook stacks
- **stashedRunbookId**: Temporarily paused runbook (for `rundown stash`/`rundown pop`)

### Runbook State Structure

Each runbook state file contains:

```json
{
  "id": "wf-2024-01-07-abc123",
  "runbook": "my-runbook.runbook.md",
  "runbookPath": ".claude/rundown/runbooks/my-runbook.runbook.md",
  "title": "My Runbook",
  "description": "Runbook description",
  "step": "2",
  "substep": "1",
  "stepName": "Execute batch",
  "retryCount": 0,
  "variables": { "environment": "staging" },
  "sources": {
    "items": { "kind": "array", "items": ["alpha", "bravo", "charlie"] },
    "log_file": { "kind": "file", "path": "data/results.jsonl", "format": "jsonl" }
  },
  "steps": [],
  "pendingSteps": [],
  "agentBindings": {},
  "substepStates": [],
  "forStack": [
    {
      "stepId": "2",
      "iteration": 2,
      "start": 1,
      "variable": "item",
      "source": { "kind": "array", "items": ["alpha", "bravo", "charlie"] },
      "currentValue": "bravo"
    }
  ],
  "iterationResults": ["pass", "pass"],
  "startedAt": "2024-01-07T10:00:00.000Z",
  "updatedAt": "2024-01-07T10:05:00.000Z",
  "prompted": false,
  "lastResult": "pass",
  "lastAction": { "type": "CONTINUE" },
  "runbookSrc": "---\nname: my-runbook\n---\n# My Runbook\n...",
  "snapshot": {}
}
```

Key fields:
- `step`: Current step identifier (string: "1", "ErrorHandler")
- `substep`: Current substep ID (e.g., "1", "2")
- `retryCount`: Current retry attempt
- `steps`: Array of step states for all runbook steps
- `lastAction`: Most recent transition as a structured object (e.g., `{"type": "CONTINUE"}`, `{"type": "GOTO", "target": "3", "at": 2}`)
- `lastResult`: Last PASS/FAIL signal (`pass` or `fail`)
- `runbookPath`: Repo-relative resolved file path to the runbook source
- `runbookSrc`: Runbook source content with template variables expanded (frozen at run time)
- `sources`: Data source definitions for FOR loops (arrays and file references)
- `forStack`: Active FOR loop stack (present during loop execution; see [FOR Loops](#for-loops))
- `forStack[].source`: Resolved source for the active loop (range, array, or file with snapshot)
- `forStack[].currentValue`: Data element at the current iteration (array/file sources)
- `iterationResults`: Array of per-iteration outcomes (`"pass"` or `"fail"`) for the current loop
- `snapshot`: XState persisted snapshot for state restoration

---

## Template Variables

Rundown supports template variables using Handlebars syntax `{{variableName}}` for parameterizing runbooks.

### Syntax

````markdown
## 1. Deploy to {{environment}}
```bash
npm run deploy --env={{environment}} --version={{version}}
```
````

### Variable Sources

Variables are collected from multiple sources with the following precedence (highest to lowest):

| Source | Description |
|--------|-------------|
| `--var key=value` | CLI flags (repeatable, highest priority) |
| `--var-file path` | YAML file specified on command line |
| `.rundown/config.yaml` | Auto-discovered from cwd upward, stops at git root |
| Frontmatter `vars:` field | Variables defined in runbook frontmatter |
| Built-in defaults | System-provided variables (Date, DateTime, Year, etc.) |

### Auto-Discovery

The CLI automatically searches for `.rundown/config.yaml` starting from the current working directory and walking upward. The search stops at:
- The first `.rundown/config.yaml` found
- The git repository root (`.git` directory)
- The filesystem root

Example `.rundown/config.yaml`:
```yaml
environment: staging
version: 1.2.3
db_host: localhost
items:
  - alpha
  - bravo
  - charlie
log_file: file:data/results.jsonl
```

Arrays become data sources for `FOR item IN {{ items }}`. The `file:` prefix creates file-backed sources. Scalar values remain regular template variables. See [Data Sources](#data-sources) for details.

### Usage Examples

```bash
# Set variables via CLI flags
rundown run deploy.runbook.md --var environment=prod --var version=2.0.0

# Load variables from a file
rundown run deploy.runbook.md --var-file production.yaml

# Combine sources (CLI flags override file values)
rundown run deploy.runbook.md --var-file base.yaml --var environment=prod
```

### Variable Name Requirements

Variable names must match the pattern `/^[a-zA-Z_][a-zA-Z0-9_]*$/`:
- Must start with a letter or underscore
- Can contain letters, digits, and underscores

### Undefined Variables

Undefined variables are preserved as literal `{{variable}}` text rather than causing an error. This allows partial variable substitution.

### State Persistence

Template variables are expanded **once** at `rd run` time. The expanded content is stored in `state.runbookSrc` to ensure resume commands (`pass`, `fail`, `goto`, `complete`, `status`, `pop`) work consistently without re-rendering.

### Distinction from Template Usage

Template variables are expanded before parsing and should not be confused with step identifiers:
- `{{variable}}` - Template variable, expanded before parsing (e.g., `{{environment}}` becomes `production`)

---

## Security Policy

Rundown enforces a security policy layer to control what commands runbooks can execute.

### Default Behavior

In `prompted` mode (default), Rundown:
- Allows common safe commands: git, npm, node, pnpm, yarn, etc.
- Blocks dangerous commands: sudo, rm, curl, wget, etc.
- Prompts for unlisted commands

### Quick Reference

| Flag | Effect |
|------|--------|
| `--allow-run <cmds>` | Allow specific commands (comma-separated) |
| `--allow-read <paths>` | Allow reading specific paths |
| `--allow-write <paths>` | Allow writing to specific paths |
| `--allow-env <vars>` | Allow specific environment variables |
| `--allow-all` | Bypass all policy checks |
| `--deny-all` | Block all commands not explicitly allowed |
| `-y, --yes` | Auto-approve prompts |
| `--non-interactive` | CI mode (auto-deny unlisted commands) |
| `--policy <file>` | Use custom policy file |

### Examples

```bash
# Allow specific commands for this run
rundown run deploy.runbook.md --allow-run docker,kubectl

# Allow file operations
rundown run backup.runbook.md --allow-read /var/log --allow-write /backup

# CI/CD: auto-approve with pre-approved commands
rundown run test.runbook.md --yes --allow-run npm,jest

# CI/CD: strict mode with no prompts
rundown run test.runbook.md --non-interactive
```

See [Security Documentation](SECURITY.md) for full details.

---

## CLI Commands

### Runbook Lifecycle

#### `rundown run <file>` - Start Runbook

Start a new runbook from a runbook file.

```bash
rundown run my-runbook.runbook.md
rundown run my-runbook.runbook.md --prompted  # Disable automatic execution
rundown run my-runbook.runbook.md --var key=value  # Set template variable (repeatable)
rundown run my-runbook.runbook.md --var-file vars.yaml  # Load variables from YAML file
```

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
rundown stop --agent <agentId>
```

Deletes runbook state and clears from session.

#### `rundown complete [message]` - Force Early Completion

Manually complete a runbook before reaching the final step.

**Note:** Runbooks auto-complete when the final step's PASS transition executes and there are no more steps. This command is only needed for early exit scenarios.

```bash
rundown complete                            # Force completion from current step
rundown complete "Skipping remaining steps" # Complete with message
rundown complete --agent myAgent            # Complete runbook in agent-specific stack
```

**When to use:**
- Early exit when remaining steps are unnecessary
- Agent-driven workflows requiring explicit completion
- Graceful exit from steps without explicit completion transitions

**Comparison with `stop`:**
- `complete` - Marks runbook as **successful**, preserves state
- `stop` - Marks runbook as **aborted/failed**, deletes state

### State Transitions

#### `rundown pass` - Mark Step Passed

Signal successful step completion.

```bash
rundown pass
rundown pass --agent <agentId>
```

**Aliases:** `rundown yes`, `rundown ok`

**Behavior:**
1. Send PASS event to XState
2. Evaluate PASS transition
3. Execute resulting action
4. Print action taken and new step

#### `rundown fail` - Mark Step Failed

Signal step failure.

```bash
rundown fail
rundown fail --agent <agentId>
```

**Alias:** `rundown no`

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
rundown goto 3       # Jump to step 3
rundown goto 3.1     # Jump to substep 3.1
```

**Restrictions:**
- Target must exist
- Resets retryCount to 0
- Clears lastResult (prevents stale state)

**Valid GOTO Formats (in runbook transitions):**

| Target | Valid From | Description |
|--------|------------|-------------|
| `GOTO N` | Any step | Jump to step N (if FOR step, implies AT 1) |
| `GOTO N.M` | Any step | Jump to substep M of step N |
| `GOTO Name` | Any step | Jump to named step |
| `GOTO Name.M` | Any step | Jump to substep M of named step |
| `GOTO N AT I` | Any step | Enter FOR step N at iteration I (only if N is a FOR step) |
| `GOTO N.M AT I` | Any step | Jump to substep M of FOR step N at iteration I |
| `GOTO Name AT I` | Any step | Enter named FOR step at iteration I |

The `AT` qualifier is only valid when the target is a step with a FOR annotation. If `AT` is omitted for a FOR step, it defaults to iteration 1 (restart from beginning). See [SPEC.md GOTO](./SPEC.md#goto) for full details.

### Status Commands

#### `rundown status` - Show Current State

Display active runbook information.

```bash
rundown status
rundown status --agent <agentId>
```

**Output:**
```
File:     my-runbook.runbook.md
State:    .claude/rundown/runs/wf-2024-01-07-abc123.json
Action:   CONTINUE
Result:   PASS

Step:     2/5

Execute batch...

Pending: 3.1
Agents:
  agent-123: 3.1 [running]
```

#### `rundown ls` - List Runbooks

List active or available runbooks.

```bash
rundown ls           # List active runbooks
rundown ls --all     # List available runbook files
rundown ls --json    # JSON output
rundown ls --all --tags review  # Filter by tag
```

**Active runbook status values:**
- `active` - Currently executing
- `stashed` - Paused via `rundown stash`
- `complete` - Successfully finished
- `stopped` - Terminated with failure
- `inactive` - In session but not active

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
rundown check my-runbook.runbook.md
```

**Output:**
```
PASS: 5 steps, 3 substeps
```
or
```
FAIL: 2 errors

Line 15: Step 3 missing (expected sequential numbering)
Line 22: Invalid transition: GOTO 10 (step does not exist)
```

### Maintenance

#### `rundown prune` - Remove Runbook State

Clean up runbook state files (not runbook source files).

```bash
rundown prune               # Remove completed runbooks (default)
rundown prune --all         # Remove all runbook state
rundown prune --dry-run     # Preview what would be removed
rundown prune --completed   # Only completed
rundown prune --inactive    # Only inactive
rundown prune --active      # Only active (careful!)
```

### Subagent Commands

| Command | Description |
|---------|-------------|
| `rundown run --step <id>` | Queue step for agent binding |
| `rundown run --agent <id>` | Bind agent to pending step |
| `rundown pass --agent <id>` | Mark agent's work as passed |
| `rundown fail --agent <id>` | Mark agent's work as failed |

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
- Current step and substep
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

# Remove completed runbook state
rundown prune --completed

# Remove all state
rundown prune --all
```

---

## Subagent Dispatch Patterns

> **See also:** [AGENT-ORCHESTRATION.md](./AGENT-ORCHESTRATION.md) for the five orchestration models, agent type conventions, and guidance on choosing a model.

### Pattern 1: Orchestrator Control

Main agent runs runbook, dispatches subagents for substeps.

**Runbook structure:**
```markdown
## 2. Execute batch
### 2.1 Process item
  - task.runbook.md

- PASS ALL: CONTINUE
- FAIL ANY: GOTO 4
```

**Command sequence:**
```bash
# 1. Main agent starts parent runbook
rd run runbook.runbook.md

# 2. At substep, main agent queues step with child runbook
rd run --step 2.1 task.runbook.md

# 3. Subagent binds to queued step (picks up runbook automatically)
rd run --agent subagent-1

# 4. Subagent works through child runbook...

# 5. Subagent reports result
rd pass --agent subagent-1    # or: rd fail --agent subagent-1
```

**Key points:**
- Child runbook is specified with `--step`, not with `--agent`
- Subagent uses `--agent` flag on all commands (`run`, `pass`, `fail`)
- Parent waits for agent result before evaluating transition

### Pattern 2: Agent-Controlled Branching

Agent decides next action based on context.

```markdown
## 5. Check remaining
- PASS: CONTINUE
- FAIL: STOP

Check TodoWrite for remaining items.

If more remain: `rundown goto 3`
If complete: `rundown pass`
```

Agent reads step, evaluates condition, runs appropriate CLI command.

---

## Output Format

Output formatting is implemented in `packages/cli/src/services/output-emitter.ts` and `packages/cli/src/helpers/table-formatter.ts`.

### Standard Output Structure

```
File:     runbook.runbook.md
State:    .claude/rundown/runs/wf-xxx.json
Action:   START

Step:     1/5

Step description here...

$ npm test

-----
Action:   CONTINUE
From:     1/5
Result:   PASS

Step:     2/5

Next step description...

Runbook:  COMPLETE
```

### Table Output

List commands (`rd ls`, `rd scenario ls`) use aligned tables following Linux CLI conventions:

| Convention | Standard |
|------------|----------|
| **Headers** | UPPERCASE, first row, no decorative lines |
| **Alignment** | Left for text, right for numbers |
| **Separator** | 2 spaces between columns |
| **Last column** | Extends to end (no padding) |
| **Empty values** | Empty string |
| **Machine output** | `--json` flag for programmatic use |

Example (`rd ls --all`):
```
NAME           DESCRIPTION                    TAGS
retry-success  Tests RETRY before exhaustion  retry, auto-exec
simple         Basic two-step runbook
```

Example (`rd scenario ls`):
```
NAME              EXPECTED  DESCRIPTION                   TAGS
completed         COMPLETE  Step passes on first attempt
retry-exhaustion  STOP      Retries exhausted, stops
```

### Detail Views

Single-item display commands (`rd scenario show`) use aligned key-value format:

| Convention | Standard |
|------------|----------|
| **Key alignment** | Pad to longest key + `:` |
| **Format** | `Key:` followed by spaces to align values |
| **Nested items** | Indent 2 spaces under label |

Example (`rd scenario show`):
```
Name:        completed
Description: Step passes on first attempt
Expected:    COMPLETE
Commands:
  $ rd run --prompted retry-success.runbook.md
  $ rd pass
```

### Command Execution Output

Commands that execute operations (`rd scenario run`) use a Scenario/Execution/Result structure:

```
Scenario: scenario-name

---
$ rd run --prompted file.runbook.md
$ rd pass

Scenario: COMPLETE
```

### Key Elements

| Element | Description |
|---------|-------------|
| `File:` | Runbook file path |
| `State:` | State JSON file path |
| `Action:` | Last action (START, CONTINUE, GOTO, RETRY, COMPLETE, STOP) |
| `From:` | Previous step position |
| `Result:` | PASS or FAIL |
| `Step:` | Current position (n/total or n.m/total) |
| `$` | Command being executed |
| `---` | Separator between scenario commands |
| `Runbook:` | Runbook terminal state (COMPLETE, STOPPED, STASHED) |

---

## Troubleshooting and Error Handling

### Common Errors and Resolutions

| Error | Cause | Resolution |
|-------|-------|------------|
| "No active runbook" | No runbook in stack | Run `rundown run <file>` |
| "Runbook file not found" | Missing runbook | Check file path |
| "Step N does not exist" | Invalid GOTO target | Check step numbers |
| "Invalid step target" | Bad goto format | Use "N" or "N.M" |
| "FOR loop references undefined data source" | Sourced FOR clause without matching source | Define source in config.yaml or --var-file |
| "File drift detected" | Data file changed during iteration | Ensure file stability or restart runbook |
| "Descending windows are not supported for file sources" | `start > end` on file source | File sources must iterate forward |

### State Recovery

If state becomes corrupted:
1. `rundown ls` - Check active runbooks
2. `rundown stop [message]` - Clear active runbook
3. `rundown prune --all` - Remove all state
4. `rundown run <file>` - Restart fresh

---

## Integration with Claude Code

See [AGENT-ORCHESTRATION.md](./AGENT-ORCHESTRATION.md) for agent type conventions and context file discovery.

### Context Injection

Active runbook prompt auto-injects into Claude conversations via hooks.

### Session Persistence

Both runbook state and session tracking survive:
- Context clears
- Session restarts
- Agent handoffs

---

## Quick Reference

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
rundown prune                # Clean up state

# Subagent Dispatch
rd run --step <id> <runbook>   # Queue step with child runbook
rd run --agent <agentId>       # Subagent binds to queued step
rd pass --agent <agentId>      # Subagent marks work passed
rd fail --agent <agentId>      # Subagent marks work failed
```