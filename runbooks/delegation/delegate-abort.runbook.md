---
name: delegate-abort
description: Token cancellation pattern for delegation abort
tags:
  - delegation

scenarios:
  abort-pending:
    description: Create delegation then abort before claim
    commands:
      - rd run --prompted delegate-abort.runbook.md
      - rd abort ${TOKEN}
      - rd pass --run-capability ${RUN_CAPABILITY}
    result: COMPLETE
---

# Delegation Abort

Create a delegation token then cancel it before claiming.

## 1. Delegated work

- PASS ALL COMPLETE
- FAIL ANY STOP

### 1.1 Child task

- DELEGATE
- delegation-child-pass.runbook.md
