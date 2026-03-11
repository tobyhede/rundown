---
name: for-nested-transitions
description: Iteration results aggregate via PASS ALL and FAIL ANY
tags:
  - for-loops
scenarios:
  completed:
    description: All iterations pass, PASS ALL continues
    commands:
      - rd run for-nested-transitions.runbook.md
    result: COMPLETE
    expect:
      steps:
        - from: "1.1.1"
          action: DEFER
          result: PASS
        - from: "1.2.1"
          action: CONTINUE
          result: PASS
          aggregated: true
        - from: "2"
          action: COMPLETE
          result: PASS
  stopped:
    description: Second iteration fails, DEFER accumulates fail, FAIL ANY fires → STOP
    commands:
      - rd run --prompted for-nested-transitions.runbook.md
      - rd pass
      - rd fail
    result: STOP
---

# FOR Nested Transitions

## 1. Validate items

- FOR item IN 1 TO 2
  - PASS DEFER
  - FAIL DEFER
- PASS ALL CONTINUE
- FAIL ANY STOP

### 1.1 Check {{item}}

```bash
rd echo "item={{item}}"
```

## 2. Finalize

- PASS COMPLETE

```bash
rd echo "done"
```
