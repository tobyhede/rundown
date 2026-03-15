---
name: for-next-action
description: NEXT action skips to the next FOR loop iteration
tags:
  - for-loops
scenarios:
  fail-skips:
    description: FAIL NEXT skips the failed iteration and loop continues
    commands:
      - rd run for-next-action.runbook.md
    result: COMPLETE
---

# FOR Next Action

## 1. Process items

- FOR item IN 1 TO 3
- PASS ALL CONTINUE
- FAIL ANY CONTINUE

### 1.1 Check {{item}}

- PASS CONTINUE
- FAIL NEXT

```bash
rd echo --result fail
```

## 2. Done

- PASS COMPLETE

```bash
rd echo "completed"
```
