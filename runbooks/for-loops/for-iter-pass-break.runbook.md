---
name: for-iter-pass-break
description: Iteration-level PASS BREAK exits loop (non-accumulating).
tags:
  - for-loops
scenarios:
  break-fires:
    description: Pass triggers BREAK — non-accumulating, parent sees vacuous pass → CONTINUE
    commands:
      - rd run --prompted for-iter-pass-break.runbook.md
      - rd pass
      - rd pass
    result: COMPLETE
  defer-fires:
    description: All fail — DEFER accumulates, parent sees failures → STOP
    commands:
      - rd run --prompted for-iter-pass-break.runbook.md
      - rd fail
      - rd fail
      - rd fail
    result: STOP
---

# FOR Iteration Pass Break

## 1. Process items

- FOR item IN 1 TO 3
  - PASS: BREAK
  - FAIL: DEFER
- PASS ALL: CONTINUE
- FAIL: STOP

### 1.1 Check {{item}}

- DEFER

```bash
rd echo "item={{item}}"
```

## 2. Done

- PASS: COMPLETE

```bash
rd echo "done"
```
