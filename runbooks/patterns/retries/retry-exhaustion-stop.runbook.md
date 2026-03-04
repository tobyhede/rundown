---
name: retry-exhaustion-stop
description: Tests that RETRY exhaustion with STOP halts the runbook
tags:
  - retries

scenarios:
  exhausted:
    description: Fails twice, exhausts retry, runbook stops
    commands:
      - rd run --prompted retry-exhaustion-stop.runbook.md
      - rd fail
      - rd fail
    result: STOP
  recovered:
    description: Fails first, succeeds on retry
    commands:
      - rd run --prompted retry-exhaustion-stop.runbook.md
      - rd fail
      - rd pass
    result: COMPLETE
  auto-execution:
    description: Code block auto-executes - fails twice, runbook stops
    commands:
      - rd run retry-exhaustion-stop.runbook.md
    result: STOP
---

# RETRY Exhaustion STOP

Tests that RETRY exhaustion with STOP halts the runbook.

## 1. Critical step

- PASS COMPLETE
- FAIL RETRY 1 STOP

Fails initially, retries once. If it fails again, it STOPS the runbook.

```bash
rd echo --result fail --result fail
```
