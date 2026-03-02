---
name: retry-exhaustion-goto
description: Tests that RETRY exhaustion with GOTO jumps to a recovery step
tags:
  - retries

scenarios:
  exhausted:
    description: Fails three times, exhausts retry, jumps to recovery step
    commands:
      - rd run --prompted retry-exhaustion-goto.runbook.md
      - rd fail
      - rd fail
      - rd fail
      - rd pass
    result: COMPLETE
  recovered:
    description: Passes on first attempt without needing recovery
    commands:
      - rd run --prompted retry-exhaustion-goto.runbook.md
      - rd pass
    result: COMPLETE
  auto-execution:
    description: Code block auto-executes - fails three times, jumps to recovery
    commands:
      - rd run retry-exhaustion-goto.runbook.md
    result: COMPLETE
---

# RETRY Exhaustion GOTO

Tests that RETRY exhaustion with GOTO jumps to a recovery step.

## 1. Flaky step
- PASS: COMPLETE
- FAIL: RETRY 2 GOTO 2

Fails up to 2 times. If it exhausts, it jumps to the recovery step.

```bash
rd echo --result fail --result fail --result fail
```

## 2. Recovery
- PASS: COMPLETE

Recovery step reached from step 1 exhaustion.

```bash
rd echo "recovered"
```
