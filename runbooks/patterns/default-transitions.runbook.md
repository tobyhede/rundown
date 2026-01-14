---
name: default-transitions
description: Tests implicit PASS to CONTINUE and FAIL to STOP when no transitions defined

scenarios:
  success:
    description: Both steps pass with implicit transitions
    commands:
      - rd run --prompted default-transitions.runbook.md
      - rd pass
      - rd pass
    result: COMPLETE
  fail-stops:
    description: First step fails, workflow stops due to implicit FAIL to STOP
    commands:
      - rd run --prompted default-transitions.runbook.md
      - rd fail
    result: STOP
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

