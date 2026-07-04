---
name: delegate-keyword-collect-pass
description: Full DELEGATE workflow — auto-issue, claim all, auto-aggregation fires COMPLETE
tags:
  - delegation
  - delegate-keyword

scenarios:
  all-pass:
    description: Auto-issue tokens, claim both passing substeps, auto-aggregation fires COMPLETE
    commands:
      - rd run delegate-keyword-collect-pass.runbook.md
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

# DELEGATE Full Collect-Pass Workflow

## 1. Review work

- DELEGATE
- PASS ALL COMPLETE
- FAIL ANY STOP

### 1.1 Review A

- delegation-child-pass.runbook.md

### 1.2 Review B

- delegation-child-pass.runbook.md
