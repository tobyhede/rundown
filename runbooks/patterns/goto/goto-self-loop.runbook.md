---
name: goto-self-loop
description: GOTO to the same step creates a retry loop until failure stops it
tags:
  - goto
  - loop

scenarios:
  looped:
    description: Pass loops back to step 1, then fail exits with STOP
    commands:
      - rd run --prompted goto-self-loop.runbook.md
      - rd pass
      - rd fail
    result: STOP

  immediate-stop:
    description: Fail immediately triggers default STOP
    commands:
      - rd run --prompted goto-self-loop.runbook.md
      - rd fail
    result: STOP
---

# GOTO Self-Loop

GOTO to the same step creates a retry loop until failure stops it.

## 1. Loop
- PASS: GOTO 1
