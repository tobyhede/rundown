---
name: for-iter-pass-continue
description: Iteration-level PASS CONTINUE exits loop without accumulating result.
tags:
  - for-loops
scenarios:
  continue-fires:
    description: Pass triggers CONTINUE — result not accumulated, parent sees empty → passes
    commands:
      - rd run --prompted for-iter-pass-continue.runbook.md
      - rd pass
      - rd pass
    result: COMPLETE
  defer-fires:
    description: All fail — DEFER accumulates, parent sees failures → STOP
    commands:
      - rd run --prompted for-iter-pass-continue.runbook.md
      - rd fail
      - rd fail
      - rd fail
    result: STOP
---

# FOR Iteration Pass Continue

## 1. Process items

- FOR item IN 1 TO 3
  - PASS CONTINUE
  - FAIL DEFER
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
