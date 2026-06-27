---
name: delegate-keyword-h2-propagation-fail
description: H2-level DELEGATE propagates to all H3 substeps; one substep fails, aggregation fires STOP
tags:
  - delegation
  - delegate-keyword

scenarios:
  one-fail:
    description: Step-level DELEGATE propagates; second substep fails; auto-aggregation fires STOP
    commands:
      - rd run delegate-keyword-h2-propagation-fail.runbook.md
      - rd claim ${TOKEN}
      - rd claim ${TOKEN_2}
      - rd collect
    expect:
      result: STOP
---

# H2-Level DELEGATE Fail-Any Path

Step-level `- DELEGATE` propagates to every substep. When any substep fails,
FAIL ANY STOP aggregation halts the parent.

## 1. Delegated work

- DELEGATE
- PASS ALL COMPLETE
- FAIL ANY STOP

### 1.1 First child task (passes)

- delegation-child-pass.runbook.md

### 1.2 Second child task (fails)

- delegation-child-fail.runbook.md
