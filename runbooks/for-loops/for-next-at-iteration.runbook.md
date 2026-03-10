---
name: for-next-at-iteration
description: NEXT at FOR iteration level skips accumulation and advances
tags:
  - for-loops
scenarios:
  completed:
    description: Iteration 1 fails (NEXT skips), iterations 2-3 pass, PASS ANY fires COMPLETE
    commands:
      - rd run --prompted for-next-at-iteration.runbook.md
      - rd fail
      - rd pass
      - rd pass
    result: COMPLETE
---

# FOR Next At Iteration Level

## 1. Process items

- FOR item IN 1 TO 3
  - PASS: DEFER
  - FAIL: NEXT
- PASS ANY: COMPLETE
- FAIL ALL: STOP

### 1.1 Attempt {{item}}

```bash
rd echo "item={{item}}"
```
