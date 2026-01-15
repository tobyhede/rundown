---
name: agent-binding-simple
description: Parent workflow delegates step to agent with child workflow
tags:
  - composition

scenarios:
  success:
    description: Agent binds and completes child workflow
    commands:
      - rd run --prompted agent-binding-simple.runbook.md
      - rd run --step 1 agent-binding-simple.runbook.md
      - rd run --agent agent-1
      - rd pass --agent agent-1
      - rd pass
    result: COMPLETE
---

# Agent Binding - Simple

Demonstrates parent workflow delegating to an agent.

## 1. Delegate to Agent
- PASS: COMPLETE
- FAIL: STOP

Please delegate this task to an agent.

- child-task.runbook.md
