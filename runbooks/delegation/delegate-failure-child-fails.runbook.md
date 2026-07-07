---
name: delegate-failure-child-fails
description: Child failure propagates STOP to parent
tags:
  - delegation

scenarios:
  child-fails:
    description: Child fails, failure propagates STOP to parent
    commands:
      - rd run delegate-failure-child-fails.runbook.md
      - rd claim ${TOKEN}
      - rd collect --claim-id ${RUN_CLAIM_ID}
    result: STOP
---

# Delegation Failure (Failing Child)

Child failure propagates STOP to the parent.

## 1. Delegate work

- PASS ALL COMPLETE
- FAIL ANY STOP "Child task failed"

### 1.1 Child task

- DELEGATE
- delegation-child-fail.runbook.md
