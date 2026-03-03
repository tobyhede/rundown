---
name: delegate-failure
description: Child failure propagates STOP to parent
tags:
  - delegation

scenarios:
  completed:
    description: Delegated work passes
    commands:
      - rd run --prompted delegate-failure.runbook.md
      - rd pass
    result: COMPLETE
  child-fails:
    description: Delegated work fails, STOP with message
    commands:
      - rd run --prompted delegate-failure.runbook.md
      - rd fail
    result: STOP
---

# Delegation Failure

Child failure propagates STOP to the parent.

## 1. Delegate work

- PASS: COMPLETE
- FAIL: STOP "Child failed"

```bash
rd echo "delegate to child"
```
