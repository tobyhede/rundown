---
name: child-task
description: Simple child runbook for sub-runbook patterns

scenarios:
  basic:
    description: Basic child runbook execution
    commands:
      - rd run --prompted child-task.runbook.md
      - rd pass
    result: COMPLETE
tags:
  - composition
---

# Child Task

## 1. Execute Task

- PASS: COMPLETE
- FAIL: STOP

Execute child runbook task.
