---
name: child-task
description: Simple child workflow for subworkflow patterns
tags: [subworkflow]

scenarios:
  basic:
    description: Basic child workflow execution
    commands:
      - rd run --prompted child-task.runbook.md
      - rd pass
    result: COMPLETE
---

# Child Task

## 1. Execute Task

- PASS: COMPLETE
- FAIL: STOP

Execute child workflow task.
