---
name: goto-named
description: Demonstrates GOTO <name> - jumping to a named step

scenarios:
  success:
    description: Navigate through Initialize -> Process -> Cleanup
    commands:
      - rd run --prompted goto-named.runbook.md
      - rd pass
      - rd pass
      - rd pass
    result: COMPLETE
  error-recovery:
    description: Process fails, jumps to ErrorHandler, then Cleanup
    commands:
      - rd run --prompted goto-named.runbook.md
      - rd pass
      - rd fail
      - rd pass
      - rd pass
    result: COMPLETE
---

# GOTO Named Step
Demonstrates GOTO <name> - jumping to a named step.

## Initialize
- PASS: GOTO Process
- FAIL: GOTO Cleanup

Set up the workflow.

```bash
rd echo --result pass
```


## Process
- PASS: GOTO Cleanup
- FAIL: GOTO ErrorHandler

Do the main work.

```bash
rd echo --result pass
```


## ErrorHandler
- PASS: GOTO Cleanup
- FAIL: STOP

Handle errors.

```bash
rd echo --result pass
```


## Cleanup
- PASS: COMPLETE
- FAIL: STOP

Clean up resources.

```bash
rd echo --result pass
```

