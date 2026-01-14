---
name: named-step-mixed-substeps
description: Demonstrates named steps with both numbered substeps (ErrorHandler.1) and named substeps (ErrorHandler.Cleanup).

scenarios:
  success-completes:
    description: Setup passes, workflow completes (skips ErrorHandler)
    commands:
      - rd run --prompted named-step-mixed-substeps.runbook.md
      - rd pass
    result: COMPLETE
  error-handler-failure:
    description: Tests error handler preparation step failing and stopping workflow
    commands:
      - rd run --prompted named-step-mixed-substeps.runbook.md
      - rd fail
      - rd fail
    result: STOP
---

# Named Step With Mixed Substeps

Demonstrates named steps with both static and named substeps.

## 1. Setup
- PASS: CONTINUE
- FAIL: GOTO ErrorHandler

Initial setup.

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


### ErrorHandler.Cleanup
- PASS: GOTO 1
- FAIL: STOP

Named cleanup substep.

```bash
rd echo "cleanup after error"
```

