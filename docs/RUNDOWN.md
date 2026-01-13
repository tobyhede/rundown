# Rundown CLI Guide and Reference

This document provides a comprehensive guide and reference for the Rundown CLI (`rundown`), explaining how it executes workflows defined in the Rundown format, tracks workflow state, manages execution, and dispatches subagents.

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
- [Integration with Claude Code](#integration-with-claude-code)
  - [Context Injection](#context-injection)
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
npm install -g @rundown/cli
```

Verify installation:
```bash
rundown --help
```

The `rd` command is an alias for `rundown`.

---

## Quick Start

**Run a workflow:**
```bash
rundown run examples/runbooks/simple.runbook.md
```

**Check status:**
```bash
rundown status
```

**Progress through steps:**
```bash
rundown pass    # Step succeeded, apply PASS transition
rundown fail    # Step failed, apply FAIL transition
```

**Stop a workflow:**
```bash
rundown stop [message]
```

---

## How It Works

### Execution Model

Rundown separates **workflow definition** from **state tracking**:

| Component | Role |
|-----------|------|
| **Runbook file** | Markdown document defining steps, transitions, and conditions |
| **CLI (`rundown`)** | Tracks state: current step, retry count, variables |
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

---

## State Persistence

### File Locations

| Path | Purpose |
|------|---------|
| `.claude/rundown/runs/` | Workflow state files (`wf-YYYY-MM-DD-xxxxx.json`) |
| `.claude/rundown/session.json` | Active workflow tracking, stash, agent stacks |
| `.claude/rundown/runbooks/` | Workflow source files (discovered for `rundown ls --all`) |

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
- **stashedWorkflowId**: Temporarily paused workflow (for `rundown stash`/`rundown pop`)

### Workflow State Structure

Each workflow state file contains:

```json
{
  "id": "wf-2024-01-07-abc123",
  "workflow": "my-workflow.runbook.md",
  "title": "My Workflow",
  "description": "Workflow description",
  "step": "2",
  "instance": 1,
  "substep": "1",
  "stepName": "Execute batch",
  "retryCount": 0,
  "variables": {},
  "steps": [],
  "pendingSteps": [],
  "agentBindings": {},
  "substepStates": [],
  "startedAt": "2024-01-07T10:00:00.000Z",
  "updatedAt": "2024-01-07T10:05:00.000Z",
  "prompted": false,
  "lastResult": "pass",
  "lastAction": "CONTINUE",
  "snapshot": {}
}
```

Key fields:
- `step`: Current step identifier (string: "1", "ErrorHandler", "{N}")
- `instance`: Dynamic workflow instance counter (1, 2, 3, ...)
- `substep`: Current substep ID (e.g., "1", "2")
- `retryCount`: Current retry attempt
- `steps`: Array of step states for all workflow steps
- `lastAction`: Most recent transition (`START`, `CONTINUE`, `GOTO`, `RETRY`, `COMPLETE`, `STOP`)
- `lastResult`: Last PASS/FAIL signal (`pass` or `fail`)
- `snapshot`: XState persisted snapshot for state restoration

---

## CLI Commands

### Workflow Lifecycle

#### `rundown run <file>` - Start Workflow

Start a new workflow from a runbook file.

```bash
rundown run my-workflow.runbook.md
rundown run my-workflow.runbook.md --prompted  # Disable automatic execution
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
- Use `rundown pass` or `rundown fail` after command

#### `rundown stop` - Abort Workflow

Immediately terminate the active workflow.

```bash
rundown stop [message]
rundown stop --agent <agentId>
```

Deletes workflow state and clears from session.

#### `rundown complete [message]` - Mark Complete

Force workflow completion (success).

```bash
rundown complete [message]                  # Mark as success with optional message
rundown complete "All tasks finished"       # Complete with custom message
```

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
- Cannot use `GOTO NEXT` via CLI (runbook-only)
- Resets retryCount to 0
- Clears lastResult (prevents stale state)

**Valid GOTO Formats (in runbook transitions):**

| Target | Valid From | Description |
|--------|------------|-------------|
| `GOTO N` | Any step | Jump to step N (must exist, N ≤ total steps) |
| `GOTO N.M` | Any step | Jump to substep M of step N |
| `GOTO {N}.M` | Dynamic step {N} | Jump to substep M within current dynamic instance |
| `GOTO NEXT` | Dynamic step {N} | Advance to next dynamic instance (N+1) |

**Notes:**
- `GOTO {N}` alone is invalid - use `GOTO NEXT` instead
- `GOTO NEXT` is only valid in runbook transitions, not via CLI

### Status Commands

#### `rundown status` - Show Current State

Display active workflow information.

```bash
rundown status
rundown status --agent <agentId>
```

**Output:**
```
File:     my-workflow.runbook.md
State:    .claude/rundown/runs/wf-2024-01-07-abc123.json
Action:   CONTINUE
Result:   PASS

Step:     2/5

Execute batch...

Pending: 3.1
Agents:
  agent-123: 3.1 [running]
```

#### `rundown ls` - List Workflows

List active or available workflows.

```bash
rundown ls           # List active workflows
rundown ls --all     # List available runbook files
rundown ls --json    # JSON output
rundown ls --all --tags review  # Filter by tag
```

**Active workflow status values:**
- `active` - Currently executing
- `stashed` - Paused via `rundown stash`
- `complete` - Successfully finished
- `stopped` - Terminated with failure
- `inactive` - In session but not active

### Enforcement Control

#### `rundown stash` - Pause Enforcement

Temporarily pause workflow tracking.

```bash
rundown stash
```

Removes active workflow from stack, preserves state.

#### `rundown pop` - Resume Enforcement

Resume from stashed workflow.

```bash
rundown pop
```

Restores stashed workflow to active stack.

### Validation

#### `rundown check <file>` - Validate Runbook

Check a runbook file for syntax errors.

```bash
rundown check my-workflow.runbook.md
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

#### `rundown prune` - Remove Workflow State

Clean up workflow state files (not runbook files).

```bash
rundown prune               # Remove completed workflows (default)
rundown prune --all         # Remove all workflow state
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

### Task: Run a Simple Sequential Workflow

```bash
# Start the workflow
rundown run myworkflow.runbook.md

# After completing each step, signal the outcome
rundown pass    # or rundown yes, rundown ok
rundown fail    # Step failed, apply FAIL transition
```

### Task: Check Workflow Status

```bash
rundown status
```

Output shows:
- Current workflow file
- State file location
- Current step and substep
- Last action taken

### Task: Jump to a Specific Step

```bash
rundown goto 3       # Jump to step 3
rundown goto 2.1     # Jump to substep 1 of step 2
```

**Note:** `GOTO NEXT` is only valid in runbook transitions, not via CLI.

### Task: Pause and Resume a Workflow

```bash
# Pause (state preserved, enforcement paused)
rundown stash

# Do untracked work...

# Resume
rundown pop
```

### Task: List Workflows

```bash
# List active/running workflows
rundown ls

# List all available runbook files
rundown ls --all

# Filter by tags
rundown ls --all --tags tdd,review
```

### Task: Validate a Runbook Before Running

```bash
rundown check myworkflow.runbook.md
```

Output: `PASS: N steps` or `FAIL: error details`

### Task: Clean Up Old Workflow State

```bash
# Preview what would be removed
rundown prune --dry-run

# Remove completed workflow state
rundown prune --completed

# Remove all state
rundown prune --all
```

---

## Subagent Dispatch Patterns

### Pattern 1: Orchestrator Control

Main agent runs workflow, dispatches subagents for substeps.

**Runbook structure:**
```markdown
## 2. Execute batch
### 2.{n} Process item
  - task.runbook.md

- PASS ALL: CONTINUE
- FAIL ANY: GOTO 4
```

**Command sequence:**
```bash
# 1. Main agent starts parent workflow
rd run workflow.runbook.md

# 2. At substep, main agent queues step with child workflow
rd run --step 2.1 task.runbook.md

# 3. Subagent binds to queued step (picks up workflow automatically)
rd run --agent subagent-1

# 4. Subagent works through child workflow...

# 5. Subagent reports result
rd pass --agent subagent-1    # or: rd fail --agent subagent-1
```

**Key points:**
- Child workflow is specified with `--step`, not with `--agent`
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

### Pattern 3: Dynamic Steps

Repeat step template until work complete.

```markdown
## {N} Process batch
- PASS: GOTO NEXT
- FAIL: STOP

### {N}.1 Execute tasks
### {N}.2 Verify results
```

`GOTO NEXT` increments instance number (N=1, N=2, ...) until agent signals completion with `FAIL` or workflow reaches COMPLETE.

---

## Output Format

### Standard Output Structure

```
File:     workflow.runbook.md
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
| "No active workflow" | No workflow in stack | Run `rundown run <file>` |
| "Workflow file not found" | Missing runbook | Check file path |
| "Step N does not exist" | Invalid GOTO target | Check step numbers |
| "Invalid step target" | Bad goto format | Use "N" or "N.M" |
| "GOTO NEXT is only valid as runbook transition" | CLI misuse | Only use in runbook transitions |

### State Recovery

If state becomes corrupted:
1. `rundown ls` - Check active workflows
2. `rundown stop [message]` - Clear active workflow
3. `rundown prune --all` - Remove all state
4. `rundown run <file>` - Restart fresh

---

## Integration with Claude Code

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
rundown run <file>           # Start workflow
rundown stop [message]       # Abort workflow with optional message
rundown complete [message]   # Mark complete with optional message

# Transitions
rundown pass                 # Step succeeded (aliases: yes, ok)
rundown fail                 # Step failed (alias: no)
rundown goto <N>             # Jump to step N
rundown goto <N.M>           # Jump to substep N.M

# Status
rundown status               # Show current state
rundown ls                   # List active workflows
rundown ls --all             # List available runbooks

# Enforcement
rundown stash                # Pause enforcement
rundown pop                  # Resume enforcement

# Maintenance
rundown check <file>         # Validate runbook
rundown prune                # Clean up state

# Subagent Dispatch
rd run --step <id> <runbook>   # Queue step with child workflow
rd run --agent <agentId>       # Subagent binds to queued step
rd pass --agent <agentId>      # Subagent marks work passed
rd fail --agent <agentId>      # Subagent marks work failed
```
