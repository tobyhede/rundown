---
name: fail-continue
description: FAIL CONTINUE proceeds to the next step on failure
tags:
  - transitions

scenarios:
  completed:
    description: Step fails, CONTINUE advances to cleanup, which passes
    commands:
      - rd run --prompted fail-continue.runbook.md
      - rd fail
      - rd pass
    result: COMPLETE
---

# FAIL CONTINUE

FAIL: CONTINUE proceeds to the next step even when a step fails.

## 1. Optional step

- PASS COMPLETE
- FAIL CONTINUE

Best effort execution.

```bash
rd echo "optional step"
```

## 2. Cleanup

- PASS COMPLETE

Executes after step 1, even if step 1 failed.

```bash
rd echo "cleanup"
```
