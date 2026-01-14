---
name: retry-counter-reset
description: Tests that GOTO resets the retry counter to 0 for the target location

scenarios:
  success:
    description: First step exhausts retry then GOTOs to step 2, which retries and succeeds
    commands:
      - rd run --prompted retry-counter-reset.runbook.md
      - rd fail
      - rd fail
      - rd fail
      - rd pass
    result: COMPLETE
---

# Retry Counter Reset on GOTO

Tests spec rule: "GOTO resets the retry counter to 0 for the target location"

## 1. First attempt
- PASS: CONTINUE
- FAIL: RETRY 1 GOTO 2

```bash
rd echo --result fail --result fail
```


## 2. Second attempt (counter should be 0 again)
- PASS: COMPLETE
- FAIL: RETRY 1 STOP

```bash
rd echo --result fail --result pass
```

