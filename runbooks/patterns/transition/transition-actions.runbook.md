---
name: transition-actions
description: Demonstrates explicit transition actions (STOP, CONTINUE, COMPLETE)
tags:
  - transition

scenarios:
  pass-stop:
    description: PASS triggers STOP, workflow halts successfully
    commands:
      - rd run --prompted transition-actions.runbook.md
      - rd pass
    result: STOP

  fail-continue:
    description: FAIL triggers CONTINUE, workflow proceeds to next step
    commands:
      - rd run --prompted transition-actions.runbook.md
      - rd goto 2
      - rd fail
      - rd pass
    result: COMPLETE

  fail-complete:
    description: FAIL triggers COMPLETE, workflow finishes successfully
    commands:
      - rd run --prompted transition-actions.runbook.md
      - rd goto 4
      - rd fail
    result: COMPLETE
---

# Transition Actions

Demonstrates explicit actions for PASS and FAIL transitions.

## 1. PASS STOP
- PASS: STOP "Workflow halted on success"
- FAIL: CONTINUE

Stops the workflow immediately if the step passes.

```bash
rd echo "critical check"
```

## 2. FAIL CONTINUE
- PASS: COMPLETE
- FAIL: CONTINUE

Proceeds to the next step even if this step fails.
"Best effort" execution.

```bash
rd echo "optional step"
```

## 3. Cleanup (for FAIL CONTINUE)
- PASS: COMPLETE

Executes after Step 2, even if Step 2 failed.

```bash
rd echo "cleanup"
```

## 4. FAIL COMPLETE
- PASS: CONTINUE
- FAIL: COMPLETE "Completed with warnings"

Completes the workflow if the step fails.
Useful for "early exit success" or "handled failure".

```bash
rd echo "check condition"
```
