---
name: retry-success
description: Tests that RETRY succeeds before count is exhausted

scenarios:
  success-first-try:
    description: Step passes on first attempt
    commands:
      - rd run --prompted retry-success.runbook.md
      - rd pass
    result: COMPLETE
  success-after-retry:
    description: Fails first, succeeds on retry
    commands:
      - rd run --prompted retry-success.runbook.md
      - rd fail
      - rd pass
    result: COMPLETE
---

# RETRY Success Before Exhaustion

Tests that RETRY succeeds before count is exhausted.

## 1. Flaky step that recovers
- PASS: COMPLETE
- FAIL: RETRY 3 STOP

```bash
rd echo --result fail --result pass
```

