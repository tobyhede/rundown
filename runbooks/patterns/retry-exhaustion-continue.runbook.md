---
name: retry-exhaustion-continue
description: Tests that RETRY exhaustion triggers CONTINUE fallback action
tags: [retry, exhaustion]

scenarios:
  retry-success:
    description: Fails initial attempt, succeeds on retry
    commands:
      - rd run --prompted retry-exhaustion-continue.runbook.md
      - rd fail
      - rd pass
    result: COMPLETE
  exhaustion:
    description: Exhausts retry, continues to fallback step
    commands:
      - rd run --prompted retry-exhaustion-continue.runbook.md
      - rd fail
      - rd fail
      - rd pass
    result: COMPLETE
---

# RETRY Exhaustion with CONTINUE

Tests that RETRY exhaustion triggers CONTINUE fallback action.

## 1. Flaky step
- PASS: COMPLETE
- FAIL: RETRY 1 CONTINUE

```bash
rd echo --result fail --result fail
```


## 2. Fallback step
- PASS: COMPLETE

```bash
rd echo --result pass
```

