---
name: for-iter-fail-continue
description: Iteration-level FAIL CONTINUE exits loop without accumulating result.
tags:
  - for-loops
scenarios:
  continue-fires:
    description: Fail triggers CONTINUE — result not accumulated, parent sees empty → passes
    commands:
      - rd run --prompted for-iter-fail-continue.runbook.md
      - rd fail
      - rd pass
    result: COMPLETE
  defer-fires:
    description: All pass — DEFER accumulates, parent sees passes → COMPLETE
    commands:
      - rd run --prompted for-iter-fail-continue.runbook.md
      - rd pass
      - rd pass
      - rd pass
      - rd pass
    result: COMPLETE
---

# FOR Iteration Fail Continue

## 1. Process items

- FOR item IN 1 TO 3
  - PASS DEFER
  - FAIL CONTINUE
- PASS ALL CONTINUE
- FAIL ANY STOP

### 1.1 Check {{item}}

- DEFER

```bash
rd echo "item={{item}}"
```

## 2. Done

- PASS COMPLETE

```bash
rd echo "done"
```
