---
name: agent-binding-failure
description: Parent handles agent failure gracefully
tags: [subworkflow, agent, error-handling]

scenarios:
  agent-fails:
    description: Agent fails, parent handles via GOTO
    commands:
      - rd run --prompted agent-binding-failure.runbook.md
      - rd run --step 1 child-task.runbook.md
      - rd run --agent agent-1
      - rd fail --agent agent-1
      - rd pass
    result: COMPLETE
---

# Agent Binding - Failure Handling

## 1. Delegate to Agent

- PASS: COMPLETE
- FAIL: GOTO Cleanup

  - child-task.runbook.md

## Cleanup

- PASS: COMPLETE
- FAIL: STOP

Handle failure gracefully.
