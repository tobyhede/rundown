# Rundown CLI Guide and Reference

This document provides a comprehensive guide and reference for the Rundown CLI (`rundown`), explaining how it executes runbooks defined in the Rundown format, tracks runbook state, manages execution, and dispatches subagents.

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
| **Format** | `.runbook.md` files | Runbook definition (steps, transitions, commands) |
| **State Machine** | XState-compiled machine | State transitions and guards |
| **Persistence** | JSON files | Runbook state survives context clears |

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
npm install -g @rundown/cli
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

#### WebContainer Environment

In WebContainer environments (e.g., StackBlitz), nested process spawning may not work correctly. The CLI includes an internal command dispatcher (`packages/cli/src/services/internal-commands.ts`) that intercepts `rd`/`rundown` commands and executes them directly without spawning a child process.

- `isInternalRdCommand()` detects rd/rundown commands
- `executeRdCommandInternal()` dispatches to internal handlers
- Currently supported: `echo` command
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
  "name": "My Runbook",
  "description": "Runbook description",
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
- `instance`: Dynamic runbook instance counter (1, 2, 3, ...)
- `substep`: Current substep ID (e.g., "1", "2")
- `retryCount`: Current retry attempt
- `steps`: Array of step states for all runbook steps
- `lastAction`: Most recent transition (`START`, `CONTINUE`, `GOTO`, `RETRY`, `COMPLETE`, `STOP`)
- `lastResult`: Last PASS/FAIL signal (`pass` or `fail`)
- `snapshot`: XState persisted snapshot for state restoration

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

#### `rundown complete [message]` - Mark Complete

Force runbook completion (success).

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
- `GOTO NEXT` is only valid in runbook transitions, not via CLI

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

**Note:** `GOTO NEXT` is only valid in runbook transitions, not via CLI.

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

### Pattern 1: Orchestrator Control

Main agent runs runbook, dispatches subagents for substeps.

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

### Pattern 3: Dynamic Steps

Repeat step template until work complete.

```markdown
## {N} Process batch
- PASS: GOTO NEXT
- FAIL: STOP

### {N}.1 Execute tasks
### {N}.2 Verify results
```

`GOTO NEXT` increments instance number (N=1, N=2, ...) until agent signals completion with `FAIL` or runbook reaches COMPLETE.

---

## Output Format

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
| "GOTO NEXT is only valid as runbook transition" | CLI misuse | Only use in runbook transitions |

### State Recovery

If state becomes corrupted:
1. `rundown ls` - Check active runbooks
2. `rundown stop [message]` - Clear active runbook
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
rundown run <file>           # Start runbook
rundown stop [message]       # Abort runbook with optional message
rundown complete [message]   # Mark complete with optional message

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