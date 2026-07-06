---
name: delegate-keyword-collect-fail
description: DELEGATE workflow — one substep fails, aggregation fires STOP
tags:
  - delegation
  - delegate-keyword

scenarios:
  one-fail:
    description: Auto-issue tokens, first passes, second fails, aggregation fires STOP
    commands:
      - rd run delegate-keyword-collect-fail.runbook.md
      - rd claim ${TOKEN}
      - rd claim ${TOKEN_2}
      - rd collect --run-capability ${RUN_CAPABILITY}
    expect:
      result: STOP
---

# DELEGATE Collect-Fail Workflow

## 1. Review work

- DELEGATE
- PASS ALL COMPLETE
- FAIL ANY STOP

### 1.1 Review A (passes)

- delegation-child-pass.runbook.md

### 1.2 Review B (fails)

- delegation-child-fail.runbook.md
