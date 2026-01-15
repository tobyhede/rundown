---
name: agent-task-lint
description: Lint task for agent
scenarios:
  completed:
    description: Lint passes
    commands:
      - rd run --rd run --prompted agent-task-lint.runbook.md
      - rd pass
    result: COMPLETE
  failure:
    description: Lint task fails
    commands:
      - rd run --prompted agent-task-lint.runbook.md
      - rd fail
    result: STOP
tags:
  - composition
---

# Lint Task

## 1. Run Linter

- PASS: COMPLETE
- FAIL: STOP

Execute lint checks.
