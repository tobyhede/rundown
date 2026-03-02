---
name: named-step-basic
description: Demonstrates mixing numbered and named steps with GOTO error handling
tags:
  - named-steps

scenarios:
  completed:
    description: Main runbook passes, completes successfully
    commands:
      - rd run --prompted named-step-basic.runbook.md
      - rd pass
    result: COMPLETE
  recovered:
    description: Main runbook fails, ErrorHandler recovers
    commands:
      - rd run --prompted named-step-basic.runbook.md
      - rd fail
      - rd pass
    result: STOP
---

# Named Steps Example

## 1. Main runbook
- FAIL: GOTO ErrorHandler
- PASS: COMPLETE SUCCESS


Do the main work

## ErrorHandler
- PASS: STOP RECOVERED
- FAIL: STOP "Unrecoverable error"


Handle any errors that occur
