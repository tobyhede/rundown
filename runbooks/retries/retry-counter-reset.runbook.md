---
name: retry-counter-reset
description: GOTO resets retry counter to zero
tags:
  - retries

scenarios:
  after-retry:
    description: Step 1 exhausts retry, GOTOs step 2 which succeeds
    commands:
      - rd run --prompted retry-counter-reset.runbook.md
      - rd fail
      - rd fail
      - rd fail
      - rd pass
    result: COMPLETE
  auto-execution:
    description: Auto-execute step 1 fails, GOTOs step 2 which retries
    commands:
      - rd run retry-counter-reset.runbook.md
    result: COMPLETE
---

# Retry Counter Reset on GOTO

Tests spec rule: "GOTO resets the retry counter to 0 for the target location"

## 1. First attempt

- PASS CONTINUE
- FAIL RETRY 1 GOTO 2

```bash
rd echo --result fail --result fail
```

## 2. Second attempt (counter should be 0 again)

- PASS COMPLETE
- FAIL RETRY 1 STOP

```bash
rd echo --result fail --result pass
```
