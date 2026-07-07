---
name: delegate-keyword-h3-explicit
description: Per-H3 DELEGATE annotation marks only the annotated substeps
tags:
  - delegation
  - delegate-keyword

scenarios:
  all-pass:
    description: Both explicitly-annotated substeps delegated; auto-aggregation fires COMPLETE
    commands:
      - rd run delegate-keyword-h3-explicit.runbook.md
      - rd claim ${TOKEN}
      - rd claim ${TOKEN_2}
      - rd collect --claim-id ${RUN_CLAIM_ID}
    expect:
      result: COMPLETE
      steps:
        - action: COMPLETE
          result: PASS
          aggregated: true
---

# Per-Substep DELEGATE Annotation

## 1. Delegated work

- PASS ALL COMPLETE
- FAIL ANY STOP

### 1.1 First child task

- DELEGATE
- delegation-child-pass.runbook.md

### 1.2 Second child task

- DELEGATE
- delegation-child-pass.runbook.md
