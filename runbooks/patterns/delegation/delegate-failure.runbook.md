---
name: delegate-failure
description: Child failure propagates STOP to parent
tags:
  - delegation

scenarios:
  child-passes:
    description: Delegated work passes, parent completes
    commands:
      - rd run delegate-failure.runbook.md
      - rd delegate delegation-child-pass.runbook.md --step 1.1
      - rd claim ${TOKEN}
    result: COMPLETE
  child-fails:
    description: Child fails, failure propagates STOP to parent
    commands:
      - rd run delegate-failure.runbook.md
      - rd delegate delegation-child-fail.runbook.md --step 1.1
      - rd claim ${TOKEN}
    result: STOP
---

# Delegation Failure

Child failure propagates STOP to the parent.

## 1. Delegate work

- PASS ALL: COMPLETE
- FAIL ANY: STOP "Child task failed"

### 1.1 Child task

Delegated to a child runbook via `rd delegate`.
