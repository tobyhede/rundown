---
name: agent-task-test
description: Test task for agent
scenarios:
  success:
    description: Test task completes successfully
    commands:
      - rd run --prompted agent-task-test.runbook.md
      - rd pass
    result: COMPLETE
  failure:
    description: Test task fails
    commands:
      - rd run --prompted agent-task-test.runbook.md
      - rd fail
    result: STOP
tags:
  - composition
---

# Test Task

## 1. Run Tests

- PASS: COMPLETE
- FAIL: STOP

Execute test suite.
