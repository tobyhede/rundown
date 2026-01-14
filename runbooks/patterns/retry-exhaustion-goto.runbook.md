---
name: retry-exhaustion-goto
description: Tests that RETRY exhaustion triggers GOTO fallback action

scenarios:
  success-after-retry:
    description: Step 1 fails then passes, continues to step 2
    commands:
      - rd run --prompted retry-exhaustion-goto.runbook.md
      - rd fail
      - rd pass
      - rd pass
    result: COMPLETE
  exhaustion-goto:
    description: Step 1 exhausts retries, GOTOs to recovery step 3
    commands:
      - rd run --prompted retry-exhaustion-goto.runbook.md
      - rd fail
      - rd fail
      - rd fail
      - rd pass
    result: COMPLETE
---

# RETRY Exhaustion with GOTO

Tests that RETRY exhaustion triggers GOTO fallback action.

## 1. Flaky step
- PASS: CONTINUE
- FAIL: RETRY 2 GOTO 3

```bash
rd echo --result fail --result fail --result fail
```


## 2. Skip
- PASS: COMPLETE

```bash
rd echo --result pass
```


## 3. Recovery step
- PASS: COMPLETE

```bash
rd echo --result pass
```

