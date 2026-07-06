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
      - rd pass --run-capability ${RUN_CAPABILITY_2}
      - rd pass --run-capability ${RUN_CAPABILITY_3}
    result: COMPLETE
  child-fails:
    description: First child fails (FAIL STOP stops the child) but the parent's FAIL ANY absorbs it non-terminally and defers to the next sibling, so `rd fail` exits 0 (the orchestrated workflow is still progressing); after the remaining child passes, FAIL ANY aggregates to STOP
    commands:
      - rd run --prompted list-fail-any.runbook.md
      - rd fail --run-capability ${RUN_CAPABILITY_2}
      - rd pass --run-capability ${RUN_CAPABILITY_3}
    result: STOP
---

# FAIL ANY Runbook List

FAIL ANY aggregate stops when any child runbook fails.

## 1. Verify all

- PASS ALL CONTINUE
- FAIL ANY STOP "Child failed"
- child-task.runbook.md
- child-task.runbook.md
