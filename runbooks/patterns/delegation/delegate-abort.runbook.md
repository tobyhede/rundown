---
name: delegate-abort
description: Token cancellation pattern for delegation abort
tags:
  - delegation

scenarios:
  completed:
    description: Create token then cancel delegation
    commands:
      - rd run --prompted delegate-abort.runbook.md
      - rd pass
      - rd pass
    result: COMPLETE
---

# Delegation Abort

Create a delegation token then cancel it.

## 1. Create delegation token
- PASS: CONTINUE
- FAIL: STOP

```bash
rd echo "create token"
```

## 2. Cancel delegation
- PASS: COMPLETE "Delegation cancelled"

```bash
rd echo "abort token"
```
