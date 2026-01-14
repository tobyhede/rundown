---
name: goto-named-to-named
description: Demonstrates navigation between named steps using GOTO

scenarios:
  success-path:
    description: Tests successful completion without errors (Setup -> Execute -> Complete)
    commands:
      - rd run --prompted goto-named-to-named.runbook.md
      - rd pass
      - rd pass
    result: COMPLETE

  error-recovery-primary:
    description: Tests primary error handler recovery (Execute fails -> ErrorHandler passes -> Setup)
    commands:
      - rd run --prompted goto-named-to-named.runbook.md
      - rd pass
      - rd fail
      - rd pass
      - rd pass
      - rd pass
    result: COMPLETE

  fallback-handler:
    description: Tests navigation to fallback handler (Execute fails -> ErrorHandler fails -> Fallback succeeds)
    commands:
      - rd run --prompted goto-named-to-named.runbook.md
      - rd pass
      - rd fail
      - rd fail
      - rd pass
    result: COMPLETE

  unrecoverable-error:
    description: Tests stopping when both error and fallback handlers fail
    commands:
      - rd run --prompted goto-named-to-named.runbook.md
      - rd pass
      - rd fail
      - rd fail
      - rd fail
    result: STOP
---

# GOTO Named To Named

Demonstrates navigation between named steps.

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
- FAIL: GOTO Fallback

Primary error handler.

```bash
rd echo "handle error"
```


## Fallback
- PASS: COMPLETE "Recovered via fallback"
- FAIL: STOP "Unrecoverable error"

Final fallback handler.

```bash
rd echo "fallback recovery"
```

