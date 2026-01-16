---
name: goto-next-qualified-step
description: Demonstrates explicitly advancing to the next step instance using GOTO NEXT syntax for step-level navigation

scenarios:
  error-handler-failure:
    description: Error handler fails to recover, runbook stops
    commands:
      - rd run --prompted goto-next-qualified-step.runbook.md
      - rd fail
      - rd fail
    result: STOP
tags:
  - navigation
---

# GOTO NEXT {N} - Explicit Step Advancement

Demonstrates explicitly advancing to next step instance from anywhere.

## {N}. Main Loop
- PASS: GOTO NEXT
- FAIL: GOTO ErrorHandler

```bash
rd echo --result pass --result fail
```


## ErrorHandler
- PASS: GOTO NEXT {N}
- FAIL: STOP

Handles errors and returns to main loop.

```bash
rd echo --result pass
```

