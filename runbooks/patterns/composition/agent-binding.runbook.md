---
name: agent-binding
description: Demonstrates parent workflow delegating to an agent, including success and failure handling.
tags:
  - composition
  - error-handling

scenarios:
  success:
    description: Agent binds and completes child workflow
    commands:
      - rd run --prompted --step 1 agent-binding.runbook.md
      - rd run --step 1 child-task.runbook.md
      - rd run --agent agent-1
      - rd pass --agent agent-1
      - rd pass
    result: COMPLETE

  agent-fails:
    description: Agent fails, parent handles failure via GOTO Cleanup
    commands:
      - rd run --prompted --step 2 agent-binding.runbook.md
      - rd run --step 2 child-task.runbook.md
      - rd run --agent agent-1
      - rd fail --agent agent-1
      - rd pass
    result: COMPLETE
---

# Agent Binding Patterns

Demonstrates delegation to agents and handling of their results.

## 1. Simple Delegation
- PASS: COMPLETE
- FAIL: STOP

Delegates a task to an agent. Requires success.

- child-task.runbook.md

## 2. Failure Handling
- PASS: COMPLETE
- FAIL: GOTO Cleanup

Delegates a task, but handles failure by jumping to cleanup.

- child-task.runbook.md

## Cleanup
- PASS: COMPLETE
- FAIL: STOP

Recover from agent failure.

```bash
rd echo "cleaning up after agent failure"
```
