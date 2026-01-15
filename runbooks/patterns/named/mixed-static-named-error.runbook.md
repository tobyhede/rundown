---
name: mixed-static-named-error
description: Demonstrates static steps with a named error handler step that redirects failures to central error handling

scenarios:
  success-path:
    description: Tests successful completion through all steps
    commands:
      - rd run --prompted mixed-static-named-error.runbook.md
      - rd pass
      - rd pass
      - rd pass
    result: COMPLETE

  error-recovery:
    description: Tests error handling and recovery by going back to setup
    commands:
      - rd run --prompted mixed-static-named-error.runbook.md
      - rd pass
      - rd fail
      - rd pass
      - rd pass
      - rd pass
      - rd pass
    result: COMPLETE

  unrecoverable-error:
    description: Tests unrecoverable error that stops the workflow
    commands:
      - rd run --prompted mixed-static-named-error.runbook.md
      - rd pass
      - rd fail
      - rd fail
    result: STOP
tags:
  - named
  - mixed
  - error-handling
---

# Mixed Static And Named With Error Handler

Demonstrates static steps with a named error handler step.

## 1. Setup
- PASS: CONTINUE
- FAIL: GOTO ErrorHandler

Prepare the environment.

```bash
rd echo "setup environment"
```


## 2. Execute
- PASS: CONTINUE
- FAIL: GOTO ErrorHandler

Execute the main task.

```bash
rd echo "execute task"
```


## 3. Cleanup
- PASS: COMPLETE
- FAIL: GOTO ErrorHandler

Final cleanup.

```bash
rd echo "cleanup resources"
```


## ErrorHandler
- PASS: GOTO 1
- FAIL: STOP "Unrecoverable error"

Central error handling step.

```bash
rd echo "handle error"
```

