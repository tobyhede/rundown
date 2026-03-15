---
name: for-iteration-transitions
description: Iteration-level transitions nested under FOR clause
tags:
  - for-loops
scenarios:
  continue-on-fail:
    description: FAIL CONTINUE per iteration allows loop to complete despite failures
    commands:
      - rd run for-iteration-transitions.runbook.md
    result: COMPLETE
---

# FOR Iteration Transitions

## 1. Process items

- FOR item IN 1 TO 3
  - FAIL CONTINUE
- PASS ALL CONTINUE
- FAIL ANY CONTINUE

### 1.1 Check {{item}}

```bash
rd echo --result fail
```

## 2. Done

- PASS COMPLETE

```bash
rd echo "completed"
```
