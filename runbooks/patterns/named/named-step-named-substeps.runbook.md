---
name: named-step-named-substeps
description: Demonstrates named steps containing named substeps with explicit step references (ErrorHandler.Prepare, ErrorHandler.Execute, ErrorHandler.Verify).

scenarios:
  success-completes:
    description: Setup passes, runbook completes (skips ErrorHandler)
    commands:
      - rd run --prompted named-step-named-substeps.runbook.md
      - rd pass
    result: COMPLETE
  error-handler-failure-at-prepare:
    description: Tests error handler failing at prepare stage and stopping runbook
    commands:
      - rd run --prompted named-step-named-substeps.runbook.md
      - rd fail
      - rd fail
    result: STOP
tags:
  - named
  - substeps
---

# Named Step With Named Substeps

Demonstrates named steps containing named substeps.

## 1. Setup
- PASS: CONTINUE
- FAIL: GOTO ErrorHandler

Initial setup.

```bash
rd echo "initial setup"
```


## ErrorHandler

### ErrorHandler.Prepare
- PASS: GOTO ErrorHandler.Execute
- FAIL: STOP

Prepare for error handling.

```bash
rd echo "prepare error handling"
```


### ErrorHandler.Execute
- PASS: GOTO ErrorHandler.Verify
- FAIL: STOP

Execute error recovery.

```bash
rd echo "execute recovery"
```


### ErrorHandler.Verify
- PASS: GOTO 1
- FAIL: STOP

Verify recovery succeeded.

```bash
rd echo "verify recovery"
```

