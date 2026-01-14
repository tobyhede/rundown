---
name: goto-from-named-step
description: Demonstrates navigation from a named step to a numbered step using GOTO

scenarios:
  success-path:
    description: Tests successful completion without errors (Setup -> Execute -> Complete)
    commands:
      - rd run --prompted goto-from-named-step.runbook.md
      - rd pass
      - rd pass
    result: COMPLETE

  error-recovery:
    description: Tests error handling by navigating from named ErrorHandler back to Setup
    commands:
      - rd run --prompted goto-from-named-step.runbook.md
      - rd pass
      - rd fail
      - rd pass
      - rd pass
      - rd pass
    result: COMPLETE

  unrecoverable-error:
    description: Tests stopping when error handler itself fails
    commands:
      - rd run --prompted goto-from-named-step.runbook.md
      - rd pass
      - rd fail
      - rd fail
    result: STOP
---

# GOTO From Named Step

Demonstrates navigation from a named step to a numbered step.

## 1. Setup
- PASS: CONTINUE
- FAIL: GOTO ErrorHandler

Initial setup.

```bash
rd echo "initial setup"
```


## 2. Execute
- PASS: COMPLETE
- FAIL: GOTO ErrorHandler

Main execution.

```bash
rd echo "main execution"
```


## ErrorHandler
- PASS: GOTO 1
- FAIL: STOP

Handle errors and retry.

```bash
rd echo "handle error"
```

