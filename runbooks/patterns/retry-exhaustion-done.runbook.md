---
name: retry-exhaustion-done
description: Tests that RETRY exhaustion triggers COMPLETE fallback action
tags:
  - retry
  - transition
  - auto-exec

scenarios:
  exhaustion:
    description: Exhausts retry count, completes via COMPLETE fallback
    commands:
      - rd run --prompted retry-exhaustion-done.runbook.md
      - rd fail
      - rd fail
    result: COMPLETE
  auto-execution:
    description: Step 1 fails twice (exhausts retry), completes via COMPLETE fallback
    commands:
      - rd run retry-exhaustion-done.runbook.md
    result: COMPLETE
---

# RETRY Exhaustion with COMPLETE

Tests that RETRY exhaustion triggers COMPLETE fallback action.

## 1. Flaky step
- PASS: CONTINUE
- FAIL: RETRY 1 COMPLETE

```bash
rd echo --result fail --result fail
```

