---
name: goto-current-dynamic-substep
description: Demonstrates GOTO X.{n} - jumping to the current instance of a dynamic substep

scenarios:
  error-handler-fails:
    description: Error handler fails and runbook stops
    commands:
      - rd run --prompted goto-current-dynamic-substep.runbook.md
      - rd fail
      - rd fail
    result: STOP
tags:
  - navigation
  - dynamic
  - substeps
---

# GOTO Current Dynamic Substep

Demonstrates `GOTO X.{n}` - referencing the current dynamic substep instance within a step.

## 1. Process Items

### 1.{n} Handle Item
- PASS: GOTO NEXT
- FAIL: GOTO ErrorHandler

Process each item in sequence.

## ErrorHandler
- PASS: GOTO 1.{n}
- FAIL: STOP

Handle errors and resume at current item.