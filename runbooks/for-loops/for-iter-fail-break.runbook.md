---
name: for-iter-fail-break
description: Iteration-level FAIL BREAK exits loop without accumulating result.
tags:
  - for-loops
scenarios:
  break-fires:
    description: Fail triggers BREAK — result not accumulated, parent sees empty → passes
    commands:
      - rd run --prompted for-iter-fail-break.runbook.md
      - rd fail --token ${TOKEN} --step 1.1 --index 1
      - rd pass --token ${TOKEN} --step 2
    result: COMPLETE
  defer-fires:
    description: All pass — DEFER accumulates, parent sees passes → COMPLETE
    commands:
      - rd run --prompted for-iter-fail-break.runbook.md
      - rd pass --token ${TOKEN} --step 1.1 --index 1
      - rd pass --token ${TOKEN} --step 1.1 --index 2
      - rd pass --token ${TOKEN} --step 1.1 --index 3
      - rd pass --token ${TOKEN} --step 2
    result: COMPLETE
---

# FOR Iteration Fail Break

## 1. Process items

- FOR item IN 1 TO 3
  - PASS DEFER
  - FAIL BREAK
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
