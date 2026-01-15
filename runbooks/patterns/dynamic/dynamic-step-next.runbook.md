---
name: dynamic-step-next
description: Tests GOTO NEXT navigation which advances to the next step in dynamic workflow

scenarios:
  iterate-then-stop:
    description: Pass to advance, then fail to stop workflow
    commands:
      - rd run --prompted dynamic-step-next.runbook.md
      - rd pass
      - rd fail
    result: STOP
tags:
  - dynamic
---

# Dynamic Step With GOTO NEXT

## {N}. Process Item
- PASS: GOTO NEXT


Execute.

