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
      - rd claim ${TOKEN}
    result: COMPLETE
---

# Delegation Failure

Child failure propagates STOP to the parent.

## 1. Delegate work

- PASS ALL COMPLETE
- FAIL ANY STOP "Child task failed"

### 1.1 Child task

- DELEGATE
- delegation-child-pass.runbook.md
