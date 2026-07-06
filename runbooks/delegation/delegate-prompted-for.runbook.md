---
name: delegate-prompted-for
description: FOR loop with unresolved bounds demotes to prompted-for, delegation completes child
tags:
  - delegation
  - for-loops
  - prompted-for

scenarios:
  prompted:
    description: Unresolved FOR demotes to prompted-for, delegation completes child
    commands:
      - rd run delegate-prompted-for.runbook.md
      - rd claim ${TOKEN}
      - rd collect --run-capability ${RUN_CAPABILITY}
    result: COMPLETE

  resolved:
    description: Variable bounds resolve, FOR iterates with delegation
    commands:
      - rd run --input N=2 delegate-prompted-for.runbook.md
      - rd claim ${TOKEN}
      - rd collect --run-capability ${RUN_CAPABILITY}
      - rd claim ${TOKEN_2}
      - rd collect --run-capability ${RUN_CAPABILITY}
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

# Prompted FOR Delegation

FOR loop with unresolved bounds (`{{N}}`) demotes to prompted-for mode. Each iteration delegates to a child runbook.

## 1. Process items

- FOR item IN 1 TO {{N}}
  - PASS DEFER
  - FAIL BREAK
- DELEGATE
- PASS ALL COMPLETE
- FAIL ANY STOP

### 1.1 Handle {{item}}

Delegated to child runbook.

- delegation-child-pass.runbook.md
