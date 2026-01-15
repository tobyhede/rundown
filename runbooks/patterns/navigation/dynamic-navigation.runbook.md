---
name: dynamic-navigation
description: Dynamic step navigation with conditional flow control and GOTO patterns

scenarios:
  single-iteration:
    description: Process one iteration then stop via fail
    commands:
      - rd run --prompted dynamic-navigation.runbook.md
      - rd pass
      - rd pass
      - rd fail
    result: STOP
  multiple-iterations:
    description: Process two iterations then stop via fail
    commands:
      - rd run --prompted dynamic-navigation.runbook.md
      - rd pass
      - rd pass
      - rd pass
      - rd pass
      - rd fail
    result: STOP
tags:
  - navigation
  - dynamic
---

# Dynamic Step Navigation

## {N}. Process Item

### {N}.1 Prepare
- PASS: GOTO {N}.2

Execute.

### {N}.2 Run
- PASS: GOTO NEXT

Execute.