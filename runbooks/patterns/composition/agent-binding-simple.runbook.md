---
name: agent-binding-simple
description: Parent runbook delegates step to agent with child runbook
tags:
  - composition

scenarios:
  completed:
    description: Agent binds and completes child runbook
    commands:
      - rd run --prompted agent-binding-simple.runbook.md
      - rd run --step 1 agent-binding-simple.runbook.md
      - rd run --agent agent-1
      - rd pass --agent agent-1
      - rd pass
    result: COMPLETE
---

# Agent Binding - Simple

Demonstrates parent runbook delegating to an agent.

## 1. Delegate to Agent
- PASS: COMPLETE
- FAIL: STOP

Please delegate this task to an agent.

- child-task.runbook.md
