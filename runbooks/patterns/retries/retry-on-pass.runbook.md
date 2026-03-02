---
name: retry-on-pass
description: Tests that RETRY on the PASS path retries when a step succeeds
tags:
  - retries

scenarios:
  exhausted:
    description: Passes three times, exhausts pass-retry, continues to next step
    commands:
      - rd run --prompted retry-on-pass.runbook.md
      - rd pass
      - rd pass
      - rd pass
      - rd pass
    result: COMPLETE
  fail-exits:
    description: Fails on first attempt, stops the runbook
    commands:
      - rd run --prompted retry-on-pass.runbook.md
      - rd fail
    result: STOP
  auto-execution:
    description: Code block auto-executes - passes three times, continues to finish
    commands:
      - rd run retry-on-pass.runbook.md
    result: COMPLETE
---

# RETRY on PASS Path

Tests that RETRY on the PASS path retries when a step succeeds.

## 1. Polling step
- PASS: RETRY 2 CONTINUE
- FAIL: STOP

Passes and retries up to 2 times. After exhaustion, CONTINUES to the next step.
This pattern is useful for polling or repeated checks.

```bash
rd echo --result pass --result pass --result pass
```

## 2. Finish
- PASS: COMPLETE

Final step reached after pass-retry exhaustion.

```bash
rd echo "polling complete"
```
