---
name: delegate-for-loop
description: FOR loop with delegation — each iteration delegates to a child runbook
tags:
  - delegation
  - for-loops

scenarios:
  completed:
    description: All iterations delegated and completed successfully
    commands:
      - rd run delegate-for-loop.runbook.md
      - rd claim ${TOKEN}
      - rd collect
      - rd claim ${TOKEN_2}
      - rd collect
    result: COMPLETE
    expect:
      steps:
        - from: "1.1.1"
          action: DEFER
          result: PASS
        - from: "1.2.1"
          action: COMPLETE
          result: PASS
          aggregated: true
---

# FOR Delegation

Each iteration delegates to a child runbook.

## 1. Process items

- FOR item IN 1 TO 2
  - PASS DEFER
  - FAIL BREAK
- DELEGATE
- PASS ALL COMPLETE
- FAIL ANY STOP

### 1.1 Handle {{item}}

Delegated to child runbook.

- delegation-child-pass.runbook.md
