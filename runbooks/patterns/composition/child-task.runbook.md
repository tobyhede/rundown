---
name: child-task
description: Simple child workflow for subworkflow patterns

scenarios:
  basic:
    description: Basic child workflow execution
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

Execute child workflow task.
