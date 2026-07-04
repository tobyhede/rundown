---
name: delegate-keyword-for-loop
description: DELEGATE on a FOR loop step — each iteration auto-issues delegation tokens
tags:
  - delegation
  - delegate-keyword
  - for-loops

scenarios:
  all-pass:
    description: Both FOR iterations delegate and complete via auto-aggregation
    commands:
      - rd run delegate-keyword-for-loop.runbook.md
      - rd claim ${TOKEN}
      - rd collect --run ${RUN_ID}
      - rd claim ${TOKEN_2}
      - rd collect --run ${RUN_ID}
    expect:
      result: COMPLETE
      steps:
        - from: "1.1.1"
          action: DEFER
          result: PASS
        - from: "1.2.1"
          action: COMPLETE
          result: PASS
          aggregated: true
---

# DELEGATE on FOR Loop Step

## 1. Process items

- FOR item IN 1 TO 2
  - PASS DEFER
  - FAIL BREAK
- DELEGATE
- PASS ALL COMPLETE
- FAIL ANY STOP

### 1.1 Handle {{item}}

- delegation-child-pass.runbook.md
