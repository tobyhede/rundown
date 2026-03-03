---
name: list-fail-any
description: FAIL ANY with runbook list stops on any child failure
tags:
  - composition

scenarios:
  completed:
    description: All child runbooks pass
    commands:
      - rd run --prompted list-fail-any.runbook.md
      - rd pass
      - rd pass
    result: COMPLETE
  child-fails:
    description: First child fails, FAIL ANY triggers STOP
    commands:
      - rd run --prompted list-fail-any.runbook.md
      - rd fail
      - rd pass
    result: STOP
---

# FAIL ANY Runbook List

FAIL ANY aggregate stops when any child runbook fails.

## 1. Verify all

- FAIL ANY: STOP "Child failed"
- child-task.runbook.md
- child-task.runbook.md
