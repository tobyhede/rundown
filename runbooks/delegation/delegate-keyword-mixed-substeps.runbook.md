---
name: delegate-keyword-mixed-substeps
description: Step with mixed DELEGATE and non-DELEGATE substeps
tags:
  - delegation
  - delegate-keyword

scenarios:
  delegate-then-manual:
    description: First substep delegated (auto-token), second resolved manually
    commands:
      - rd run delegate-keyword-mixed-substeps.runbook.md
      - rd claim ${TOKEN}
      - rd pass
    expect:
      result: COMPLETE
      steps:
        - action: COMPLETE
          result: PASS
          aggregated: true
---

# Mixed DELEGATE and Manual Substeps

## 1. Mixed work

- PASS ALL COMPLETE
- FAIL ANY STOP

### 1.1 Delegated task

- DELEGATE
- delegation-child-pass.runbook.md

### 1.2 Manual task

Review the output of task 1.1 and confirm.
