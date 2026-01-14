---
name: static-step-mixed-substeps
description: Demonstrates static steps containing both numbered and named substeps, including dynamic step transitions.

scenarios:
  happy-path:
    description: Test successful execution through all steps
    commands:
      - rd run --prompted static-step-mixed-substeps.runbook.md
      - rd pass
      - rd pass
      - rd pass
    result: COMPLETE

  cleanup-failure-stops:
    description: Test error in cleanup substep stops workflow
    commands:
      - rd run --prompted static-step-mixed-substeps.runbook.md
      - rd pass
      - rd fail
    result: STOP
---

# Static Step With Mixed Substeps

Demonstrates static steps containing both numbered and named substeps.

## 1. Setup

### 1.1 Prepare
- PASS: CONTINUE
- FAIL: STOP

Prepare the environment.

```bash
rd echo "prepare environment"
```


### 1.Cleanup
- PASS: CONTINUE
- FAIL: STOP

Named cleanup substep.

```bash
rd echo "cleanup resources"
```


## 2. Execute
- PASS: COMPLETE
- FAIL: GOTO 1.Cleanup

Run the main task.

```bash
rd echo "execute main task"
```

