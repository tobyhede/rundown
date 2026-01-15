---
name: named-steps
description: Demonstrates mixing numbered and named steps with GOTO error handling

scenarios:
  completed:
    description: Main workflow passes, completes successfully
    commands:
      - rd run --prompted named-steps.runbook.md
      - rd pass
    result: COMPLETE
  recovered:
    description: Main workflow fails, ErrorHandler recovers
    commands:
      - rd run --prompted named-steps.runbook.md
      - rd fail
      - rd pass
    result: STOP
tags:
  - named
---

# Named Steps Example

## 1. Main workflow
- FAIL: GOTO ErrorHandler
- PASS: COMPLETE SUCCESS


Do the main work

## ErrorHandler
- PASS: STOP RECOVERED
- FAIL: STOP "Unrecoverable error"


Handle any errors that occur
