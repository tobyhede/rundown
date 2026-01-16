---
name: dynamic-substep-transitions
description: Tests navigation transitions in dynamic substeps with GOTO NEXT and STOP conditions

scenarios:
  fail-with-stop:
    description: Fail task to stop runbook with error message
    commands:
      - rd run --prompted dynamic-substep-transitions.runbook.md
      - rd fail
    result: STOP
tags:
  - transition
  - dynamic
  - substeps
---

# Dynamic Substep Transitions
Tests navigation in dynamic context.

## {N}. Dynamic Template

### {N}.1 Task
- PASS: GOTO NEXT
- FAIL: STOP "Dynamic failure"

Process item.