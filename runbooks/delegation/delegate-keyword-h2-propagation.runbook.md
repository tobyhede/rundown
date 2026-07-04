---
name: delegate-keyword-h2-propagation
description: H2-level DELEGATE propagates to all H3 substeps
tags:
  - delegation
  - delegate-keyword

scenarios:
  all-pass:
    description: Step-level DELEGATE propagates to substeps; all pass, auto-aggregation fires COMPLETE
    commands:
      - rd run delegate-keyword-h2-propagation.runbook.md
      - rd claim ${TOKEN}
      - rd claim ${TOKEN_2}
      - rd collect --run ${RUN_ID}
    expect:
      result: COMPLETE
      steps:
        - action: COMPLETE
          result: PASS
          aggregated: true
---

# H2-Level DELEGATE Propagates to All Substeps

Step-level `- DELEGATE` marks every H3 substep for delegation without per-substep annotation.

## 1. Delegated work

- DELEGATE
- PASS ALL COMPLETE
- FAIL ANY STOP

### 1.1 First child task

- delegation-child-pass.runbook.md

### 1.2 Second child task

- delegation-child-pass.runbook.md
