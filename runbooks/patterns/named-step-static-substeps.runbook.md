---
name: named-step-static-substeps
description: Demonstrates named steps containing static numbered substeps (ErrorHandler.1, ErrorHandler.2, ErrorHandler.3).

scenarios:
  success-completes:
    description: Setup passes, workflow completes (skips ErrorHandler)
    commands:
      - rd run --prompted named-step-static-substeps.runbook.md
      - rd pass
    result: COMPLETE
  error-handler-failure-at-prepare:
    description: Tests error handler failing at first prepare step and stopping workflow
    commands:
      - rd run --prompted named-step-static-substeps.runbook.md
      - rd fail
      - rd fail
    result: STOP
---

# Named Step With Static Substeps

Demonstrates named steps containing numbered substeps.

## 1. Setup
- PASS: CONTINUE
- FAIL: GOTO ErrorHandler

Initial setup step.

```bash
rd echo "initial setup"
```


## ErrorHandler

### ErrorHandler.1 Prepare
- PASS: CONTINUE
- FAIL: STOP

Prepare for error handling.

```bash
rd echo "prepare error handling"
```


### ErrorHandler.2 Execute
- PASS: CONTINUE
- FAIL: STOP

Execute error recovery.

```bash
rd echo "execute recovery"
```


### ErrorHandler.3 Verify
- PASS: GOTO 1
- FAIL: STOP

Verify recovery succeeded.

```bash
rd echo "verify recovery"
```

