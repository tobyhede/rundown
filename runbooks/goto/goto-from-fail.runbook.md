---
name: goto-from-fail
description: FAIL triggers GOTO to a recovery step
tags:
  - goto

scenarios:
  recovered:
    description: Fail step 1 (GOTO 2), pass recovery step 2
    commands:
      - rd run --prompted goto-from-fail.runbook.md
      - rd fail
      - rd pass
    result: COMPLETE
  completed:
    description: Pass step 1 directly
    commands:
      - rd run --prompted goto-from-fail.runbook.md
      - rd pass
    result: COMPLETE
---

# GOTO From Fail

Fail step 1 to jump to the recovery step, or pass directly.

## 1. Risky Operation

- PASS COMPLETE
- FAIL GOTO 2

```bash
rd echo "risky operation"
```

## 2. Recovery

- PASS COMPLETE

```bash
rd echo "recovery"
```
