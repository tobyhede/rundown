---
name: delegate-keyword-auto-issue
description: rd run on a DELEGATE step auto-issues delegation tokens without rd delegate
tags:
  - delegation
  - delegate-keyword

scenarios:
  tokens-issued:
    description: rd run auto-issues tokens; claiming both runs the children and auto-aggregation completes the parent
    commands:
      - rd run delegate-keyword-auto-issue.runbook.md
      - rd claim ${TOKEN}
      - rd claim ${TOKEN_2}
      - rd collect --run-capability ${RUN_CAPABILITY}
    expect:
      result: COMPLETE
      steps:
        - action: COMPLETE
          result: PASS
          aggregated: true
---

# DELEGATE Step Auto-Issues Tokens on rd run

## 1. Auto-issued delegations

- DELEGATE
- PASS ALL COMPLETE
- FAIL ANY STOP

### 1.1 First task

- delegation-child-pass.runbook.md

### 1.2 Second task

- delegation-child-pass.runbook.md
