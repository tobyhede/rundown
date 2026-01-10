# Rundown CLI Guide and Reference

This document provides a comprehensive guide and reference for the Rundown CLI (`tsv`), explaining how it executes workflows defined in the Rundown format, tracks workflow state, manages execution, and dispatches subagents.

**For syntax and format details, see:**
- [SPEC.md](./SPEC.md) - Rundown specification
- [FORMAT.md](./FORMAT.md) - Format grammar and expansion rules

---

## Table of Contents

- [Architecture Overview](#architecture-overview)
- [Installation](#installation)
- [Quick Start](#quick-start)
- [How It Works](#how-it-works)
  - [Execution Model](#execution-model)
  - [State Machine](#state-machine)
  - [Command Execution](#command-execution)
- [State Persistence](#state-persistence)
  - [File Locations](#file-locations)
  - [Session Structure](#session-structure)
  - [Workflow State Structure](#workflow-state-structure)
- [CLI Commands](#cli-commands)
  - [Workflow Lifecycle](#workflow-lifecycle)
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
  - [Pattern 3: Dynamic Steps](#pattern-3-dynamic-steps)
- [Output Format](#output-format)
  - [Standard Output Structure](#standard-output-structure)
  - [Key Elements](#key-elements)
- [Troubleshooting and Error Handling](#troubleshooting-and-error-handling)
  - [Common Errors and Resolutions](#common-errors-and-resolutions)
  - [State Recovery](#state-recovery)
- [Integration with Turboshovel](#integration-with-turboshovel)
  - [Context Injection](#context-injection)
  - [Quality Gates](#quality-gates)
  - [Session Persistence](#session-persistence)
- [Quick Reference](#quick-reference)

---

## Architecture Overview

The Rundown system separates concerns into three layers:

| Layer | Component | Responsibility |
|-------|-----------|----------------|
| **Format** | `.runbook.md` files | Workflow definition (steps, transitions, commands) |
| **State Machine** | XState-compiled machine | State transitions and guards |
| **Persistence** | JSON files | Workflow state survives context clears |

The CLI is a control interface. Claude executes the actual work.

```
[Runbook File] --> [Parser] --> [XState Machine] --> [State Manager]
                                       ^                    |
                                       |                    v
                              [CLI Commands] <---- [Persisted JSON]
```

---

## Installation

```bash
npm install -g @turboshovel/cli
```

Verify installation:
```bash
tsv --help
```

The `turboshovel` command is an alias for `tsv`.

---

## Quick Start

**Run a workflow:**
```bash
tsv run examples/runbooks/simple.runbook.md
```

**Check status:**
```bash
tsv status
```

**Progress through steps:**
```bash
tsv pass    # Step succeeded, apply PASS transition
tsv fail    # Step failed, apply FAIL transition
```

**Stop a workflow:**
```bash
tsv stop
```

---

## How It Works

### Execution Model

Rundown separates **workflow definition** from **state tracking**:

| Component | Role |
|-----------|------|
| **Runbook file** | Markdown document defining steps, transitions, and conditions |
| **CLI (`tsv`)** | Tracks state: current step, retry count, variables |
| **Agent (Claude)** | Executes work, uses CLI to report outcomes |

**Key concept:** The CLI does not execute your code. It tracks which step you are on and what happens when you report PASS or FAIL. The agent (or user) does the actual work.

### State Machine

The CLI compiles runbooks into an XState state machine. Each step (and substep) becomes a state. Events (`PASS`, `FAIL`, `GOTO`, `RETRY`) trigger transitions.

#### Compilation
Runbooks compile to XState machines at runtime. Steps become states:

| Runbook Element | XState State ID |
|-----------------|-----------------|
| `## 1. Title` | `step_1` |
| `## 2. Title` | `step_2` |
| `### 2.1 Substep` | `step_2_1` |
| `### 2.{n} Dynamic` | `step_2_1`, `step_2_2`, ... |

Terminal states: `COMPLETE`, `STOPPED`

#### Events
The state machine responds to these events:

| Event | Trigger | Effect |
|-------|---------|--------|
| `PASS` | `tsv pass` or command exit 0 | Evaluate PASS transition |
| `FAIL` | `tsv fail` or command exit non-0 | Evaluate FAIL transition |
| `GOTO` | `tsv goto N` or GOTO action | Jump to step N |
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

Example of a step that auto-executes:
````markdown
## 3. Run tests
```bash
npm test
```
- PASS: CONTINUE
- FAIL: RETRY 2
````

Example of a prompted step:
````markdown
## 4. Code review
Review the implementation for issues.
`tsv pass` if acceptable, `tsv fail` if blocked.
- PASS: CONTINUE
- FAIL: STOP
````

---

## State Persistence

### File Locations

| Path | Purpose |
|------|---------|
| `.claude/turboshovel/runbooks/` | Workflow state files (`wf-YYYY-MM-DD-xxxxx.json` or `wf-2024-01-07-abc123.json`) |
| `.claude/turboshovel/session.json` | Active workflow tracking, stash, agent stacks |

### Session Structure

The session tracks which workflows are active using a **stack-based model**:

```json
{
  "stacks": {
    "agent-123": ["wf-2024-01-07-abc123"]
  },
  "defaultStack": ["wf-2024-01-07-xyz789"],
  "stashedWorkflowId": null
}
```

- **defaultStack**: Main workflow stack (no agent ID)
- **stacks**: Per-agent workflow stacks
- **stashedWorkflowId**: Temporarily paused workflow (for `tsv stash`/`tsv pop`)

### Workflow State Structure

Each workflow state file contains:

```json
{
  "id": "wf-2024-01-07-abc123",
  "workflow": "my-workflow.runbook.md",
  "title": "My Workflow",
  "step": 2,
  "substep": "1",
  "stepName": "Execute batch",
  "retryCount": 0,
  "variables": {},
  "pendingSteps": [],
  "agentBindings": {},
  "startedAt": "2024-01-07T10:00:00.000Z",
  "updatedAt": "2024-01-07T10:05:00.000Z",
  "prompted": false,
  "lastResult": "pass",
  "lastAction": "CONTINUE",
  "snapshot": { /* XState snapshot */ }
}
```

Key fields:
- `step`: Current step number (1-indexed)
- `substep`: Current substep ID (e.g., "1", "2")
- `retryCount`: Current retry attempt
- `lastAction`: Most recent transition (`START`, `CONTINUE`, `GOTO`, `RETRY`, `COMPLETE`, `STOP`)
- `lastResult`: Last PASS/FAIL signal
- `snapshot`: XState persisted snapshot for state restoration

---

## CLI Commands

### Workflow Lifecycle

#### `tsv run <file>` - Start Workflow

Start a new workflow from a runbook file.

```bash
tsv run my-workflow.runbook.md
tsv run my-workflow.runbook.md --prompted  # Disable automatic execution
```

**Behavior:**
1. Parse runbook file
2. Create workflow state with unique ID
3. Push workflow to session stack
4. Enter execution loop

**Execution Loop:**
- Auto-execute bash code blocks (unless `--prompted`)
- Exit code 0 = PASS, non-zero = FAIL
- Stop at prompt-only steps (no code block)
- Continue until COMPLETE or STOP

**With `--prompted`:**
- Commands displayed but not executed
- Agent must run command manually
- Use `tsv pass` or `tsv fail` after command

#### `tsv stop` - Abort Workflow

Immediately terminate the active workflow.

```bash
tsv stop
tsv stop --agent <agentId>
```

Deletes workflow state and clears from session.

#### `tsv complete` - Mark Complete

Force workflow completion (success or stopped).

```bash
tsv complete                    # Mark as success
tsv complete --status stopped   # Mark as stopped
```

### State Transitions

#### `tsv pass` - Mark Step Passed

Signal successful step completion.

```bash
tsv pass
tsv pass --agent <agentId>
```

**Aliases:** `tsv yes`, `tsv ok`

**Behavior:**
1. Send PASS event to XState
2. Evaluate PASS transition
3. Execute resulting action
4. Print action taken and new step

#### `tsv fail` - Mark Step Failed

Signal step failure.

```bash
tsv fail
tsv fail --agent <agentId>
```

**Alias:** `tsv no`

**Behavior:**
1. Send FAIL event to XState
2. Evaluate FAIL transition (may trigger RETRY)
3. Execute resulting action
4. Print action taken

For RETRY transitions:
- If `retryCount < max`: increment count, stay in step
- If exhausted: execute fallback action (default: STOP)

#### `tsv goto <step>` - Jump to Step

Navigate directly to a step.

```bash
tsv goto 3       # Jump to step 3
tsv goto 3.1     # Jump to substep 3.1
```

**Restrictions:**
- Target must exist
- Cannot use `GOTO NEXT` via CLI (runbook-only)
- Resets retryCount to 0
- Clears lastResult (prevents stale state)

### Status Commands

#### `tsv status` - Show Current State

Display active workflow information.

```bash
tsv status
tsv status --agent <agentId>
```

**Output:**
```
File:     my-workflow.runbook.md
State:    .claude/turboshovel/runbooks/wf-2024-01-07-abc123.json
Action:   CONTINUE
Result:   PASS

Step:     2/5

Execute batch...

Pending: 3.1
Agents:
  agent-123: 3.1 [running]
```

#### `tsv ls` - List Workflows

List active or available workflows.

```bash
tsv ls           # List active workflows
tsv ls --all     # List available runbook files
tsv ls --json    # JSON output
tsv ls --all --tags review  # Filter by tag
```

**Active workflow status values:**
- `active` - Currently executing
- `stashed` - Paused via `tsv stash`
- `complete` - Successfully finished
- `stopped` - Terminated with failure
- `inactive` - In session but not active

### Enforcement Control

#### `tsv stash` - Pause Enforcement

Temporarily pause workflow tracking.

```bash
tsv stash
```

Removes active workflow from stack, preserves state.

#### `tsv pop` - Resume Enforcement

Resume from stashed workflow.

```bash
tsv pop
```

Restores stashed workflow to active stack.

### Validation

#### `tsv check <file>` - Validate Runbook

Check a runbook file for syntax errors.

```bash
tsv check my-workflow.runbook.md
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

#### `tsv prune` - Remove Workflow State

Clean up workflow state files (not runbook files).

```bash
tsv prune               # Remove completed workflows (default)
tsv prune --all         # Remove all workflow state
tsv prune --dry-run     # Preview what would be removed
tsv prune --completed   # Only completed
tsv prune --inactive    # Only inactive
tsv prune --active      # Only active (careful!)
```

#### `tsv gate <name>` - Run Gate

Execute a named gate from turboshovel.json.

```bash
tsv gate lint
tsv gate test
```

Loads gate configuration and executes command.

### Subagent Commands

| Command | Description |
|---------|-------------|
| `tsv run --step <id>` | Queue step for agent binding |
| `tsv run --agent <id>` | Bind agent to pending step |
| `tsv pass --agent <id>` | Mark agent's work as passed |
| `tsv fail --agent <id>` | Mark agent's work as failed |

---

## Common Tasks

### Task: Run a Simple Sequential Workflow

```bash
# Start the workflow
tsv run myworkflow.runbook.md

# After completing each step, signal the outcome
tsv pass    # or tsv yes, tsv ok
tsv fail    # Step failed, apply FAIL transition
```

### Task: Check Workflow Status

```bash
tsv status
```

Output shows:
- Current workflow file
- State file location
- Current step and substep
- Last action taken

### Task: Jump to a Specific Step

```bash
tsv goto 3       # Jump to step 3
tsv goto 2.1     # Jump to substep 1 of step 2
```

**Note:** `GOTO NEXT` is only valid in runbook transitions, not via CLI.

### Task: Pause and Resume a Workflow

```bash
# Pause (state preserved, enforcement paused)
tsv stash

# Do untracked work...

# Resume
tsv pop
```

### Task: List Workflows

```bash
# List active/running workflows
tsv ls

# List all available runbook files
tsv ls --all

# Filter by tags
tsv ls --all --tags tdd,review
```

### Task: Validate a Runbook Before Running

```bash
tsv check myworkflow.runbook.md
```

Output: `PASS: N steps` or `FAIL: error details`

### Task: Clean Up Old Workflow State

```bash
# Preview what would be removed
tsv prune --dry-run

# Remove completed workflow state
tsv prune --completed

# Remove all state
tsv prune --all
```

### Task: Run a Quality Gate

```bash
tsv gate lint
```

Gates are defined in `.claude/turboshovel.json`. See [SETUP.md](../SETUP.md).

---

## Subagent Dispatch Patterns

### Pattern 1: Orchestrator Control

Main agent runs workflow, dispatches subagents for substeps.

```markdown
## 2. Execute batch
### 2.{n} Process item
  - task.runbook.md

- PASS ALL: CONTINUE
- FAIL ANY: GOTO 4
```

**Orchestrator workflow:**
1. `tsv run workflow.runbook.md` - Start main workflow
2. At substep with nested workflow: dispatch subagent
3. `tsv run --step 2.1` - Queue step for binding
4. `tsv run --agent <id>` - Bind agent to step (starts child workflow)
5. Subagent works through child workflow
6. `tsv pass --agent <id>` or `tsv fail --agent <id>` - Report result

### Pattern 2: Agent-Controlled Branching

Agent decides next action based on context.

```markdown
## 5. Check remaining

Check TodoWrite for remaining items.

If more remain: `tsv goto 3`
If complete: `tsv pass`

- PASS: CONTINUE
- FAIL: STOP
```

Agent reads step, evaluates condition, runs appropriate CLI command.

### Pattern 3: Dynamic Steps

Repeat step template until work complete.

```markdown
## {N} Process batch
### {N}.1 Execute tasks
### {N}.2 Verify results

- PASS: GOTO NEXT
- FAIL: STOP
```

`GOTO NEXT` increments instance number (N=1, N=2, ...) until agent signals completion with `FAIL` or workflow reaches COMPLETE.

---

## Output Format

### Standard Output Structure

```
File:     workflow.runbook.md
State:    .claude/turboshovel/runbooks/wf-xxx.json
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
| `-----` | Separator between transitions |

---

## Troubleshooting and Error Handling

### Common Errors and Resolutions

| Error | Cause | Resolution |
|-------|-------|------------|
| "No active workflow" | No workflow in stack | Run `tsv run <file>` |
| "Workflow file not found" | Missing runbook | Check file path |
| "Step N does not exist" | Invalid GOTO target | Check step numbers |
| "Invalid step target" | Bad goto format | Use "N" or "N.M" |
| "GOTO NEXT is only valid as runbook transition" | CLI misuse | Only use in runbook transitions |

### State Recovery

If state becomes corrupted:
1. `tsv ls` - Check active workflows
2. `tsv stop` - Clear active workflow
3. `tsv prune --all` - Remove all state
4. `tsv run <file>` - Restart fresh

---

## Integration with Turboshovel

### Context Injection

Active runbook prompt auto-injects into Claude conversations via Turboshovel hooks.

### Quality Gates

Gates can be triggered:
- By runbook commands (`tsv gate lint`)
- By PostToolUse hooks
- By file patterns

### Session Persistence

Both runbook state and session tracking survive:
- Context clears
- Session restarts
- Agent handoffs

---

## Quick Reference

```bash
# Lifecycle
tsv run <file>           # Start workflow
tsv stop                 # Abort workflow
tsv complete             # Mark complete

# Transitions
tsv pass                 # Step succeeded (aliases: yes, ok)
tsv fail                 # Step failed (alias: no)
tsv goto <N>             # Jump to step N
tsv goto <N.M>           # Jump to substep N.M

# Status
tsv status               # Show current state
tsv ls                   # List active workflows
tsv ls --all             # List available runbooks

# Enforcement
tsv stash                # Pause enforcement
tsv pop                  # Resume enforcement

# Maintenance
tsv check <file>         # Validate runbook
tsv prune                # Clean up state
tsv gate <name>          # Run named gate
```