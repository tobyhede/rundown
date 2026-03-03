---
name: default-implicit
description: Implicit default transitions (PASS CONTINUE, FAIL STOP)
tags:
  - transitions

scenarios:
  completed:
    description: Both steps pass with implicit transitions
    commands:
      - rd run --prompted default-implicit.runbook.md
      - rd pass
      - rd pass
    result: COMPLETE
  stopped:
    description: First step fails, runbook stops due to implicit FAIL to STOP
    commands:
      - rd run --prompted default-implicit.runbook.md
      - rd fail
    result: STOP
  auto-execution:
    description: Both steps pass with implicit default transitions
    commands:
      - rd run default-implicit.runbook.md
    result: COMPLETE
---

# Default Transitions

Tests implicit PASS→CONTINUE, FAIL→STOP when no transitions defined.

## 1. Step with no transitions

```bash
rd echo --result pass
```

## 2. Final step

- PASS: COMPLETE

```bash
rd echo --result pass
```
