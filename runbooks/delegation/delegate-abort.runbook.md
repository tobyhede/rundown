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
      - rd delegate delegation-child-pass.runbook.md --step 1.1
      - rd abort ${TOKEN}
      - rd pass
    result: COMPLETE
---

# Delegation Abort

Create a delegation token then cancel it before claiming.

## 1. Delegated work

- PASS ALL COMPLETE
- FAIL ANY STOP

### 1.1 Child task

Delegated to a child runbook via `rd delegate`, then aborted.
