---
name: workflow
description: Use when executing multi-step processes requiring state persistence and agent coordination - defines two-tier protocol where subagents report PASS/FAIL status and main agent handles dispatch, advancement, and failure troubleshooting
---

# Workflow Execution

## Overview

Workflows are multi-step processes with state tracking. **Two-tier orchestration:** subagents execute individual steps and report outcomes; main agent dispatches, monitors, and handles failures.

**Core principle:** Subagents fail fast, main agent troubleshoots.

## When to Use

- Multi-step processes needing state persistence across context clears
- Parallel subagent orchestration with status tracking
- PASS/FAIL signaling between agents
- Processes requiring retry/resume capability

**Not for:** Single-step steps, ad-hoc commands

---

## For Subagents

You're executing a workflow step. Your context shows:
- **Step N:** What you need to do
- **Attempt:** Retry count if applicable

### Protocol

1. Execute the step as described in the prompt
2. End your response with a status line: `STATUS: PASS` or `STATUS: FAIL`
3. If stuck, blocked, or unclear, report `STATUS: FAIL` - main agent will handle

**Do NOT:**
- Advance the parent workflow - only your orchestrator does that
- Try to fix infrastructure issues - report FAIL and let main handle
- Continue past errors - fail fast so main can troubleshoot

**You CAN:** Run your own nested workflows with full `workflow` commands.

---

## For Main Agent

You orchestrate the workflow. Use these commands:

| Command | Purpose |
|---------|---------|
| `rundown run <file>` | Begin a runbook |
| `rundown pass` | Mark current step as passed |
| `rundown fail` | Mark current step as failed |
| `rundown goto N` | Jump to specific step |
| `rundown status` | Check current state |
| `rundown complete` | Mark workflow finished |
| `rundown stop` | Abort workflow |
| `rundown stash` | Pause enforcement (for ad-hoc work) |
| `rundown pop` | Resume enforcement |

### Dispatching Steps

Include StepId in Step tool description - hooks handle the rest automatically:
```
Step(description="2.1 - Review authentication code", ...)
```

The StepId format is `N.X` where N is step number, X is substep number.

**Hook automation:**
- PostToolUse hook parses StepId from description, calls `rundown run --step 2.1`
- SubagentStart hook binds the agent to the queued step
- SubagentStop hook parses STATUS line, calls `rundown next --pass/--fail --agent {id}`

**Do NOT manually call `rundown run --step`** - hooks handle this.

### Parallel Substeps

For parallel execution (e.g., `### 2.{n}` substeps):
1. Dispatch all agents in one message (multiple Step tool calls)
2. Run `rundown status` to check agent completion
3. When all agents report done, run `rundown next`

### Dynamic Substep `{n}` Syntax

`### N.{n}` marks dynamic substeps - orchestrator decides count at runtime.

Dispatch with sequential StepIds in description:
```
Step(description="3.1 - Agent 1 review", ...)
Step(description="3.2 - Agent 2 review", ...)
```

- `$n` in workflow prompts substitutes with substep number (1, 2, etc.)
- Hooks handle step queuing and agent binding automatically

### Handling Failures

When subagent reports `STATUS: FAIL`: check output, discuss with user, then retry or jump (`--goto N`) or abort (`stop`).

---

## Common Mistakes

| Mistake | Fix |
|---------|-----|
| Subagent advances parent workflow | Only advance your own nested workflow, not parent's |
| Subagent auto-retries on failure | Report `STATUS: FAIL` and let main handle |
| Main agent auto-retries without user | Always discuss failures before retry |
| Missing StepId in dispatch | Include `N.X` format in Step tool description |
| Parallel steps without status check | Run `rundown status` before advancing |
| Manually calling `rundown run --step` | Remove - hooks handle step queuing automatically |