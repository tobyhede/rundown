---
name: retry-exhaustion-continue
description: Tests that RETRY exhaustion with CONTINUE proceeds to the next step
tags:
  - retries

scenarios:
  exhausted:
    description: Fails twice, exhausts retry, continues to cleanup step
    commands:
      - rd run --prompted retry-exhaustion-continue.runbook.md
      - rd fail
      - rd fail
      - rd pass
    result: COMPLETE
  recovered:
    description: Fails first, succeeds on retry without reaching cleanup
    commands:
      - rd run --prompted retry-exhaustion-continue.runbook.md
      - rd fail
      - rd pass
    result: COMPLETE
  auto-execution:
    description: Code block auto-executes - fails twice, continues to cleanup
    commands:
      - rd run retry-exhaustion-continue.runbook.md
    result: COMPLETE
---

# RETRY Exhaustion CONTINUE

Tests that RETRY exhaustion with CONTINUE proceeds to the next step.

## 1. Best-effort step

- PASS: COMPLETE
- FAIL: RETRY 1 CONTINUE

Fails initially, retries once. If it fails again, it CONTINUES to the next step.

```bash
rd echo --result fail --result fail
```

## 2. Cleanup

- PASS: COMPLETE

Cleanup step reached after exhaustion of step 1.

```bash
rd echo "cleanup reached"
```
