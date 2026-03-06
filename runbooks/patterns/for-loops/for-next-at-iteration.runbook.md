---
name: for-next-at-iteration
description: NEXT at FOR iteration level skips accumulation and advances
tags:
  - for-loops
scenarios:
  completed:
    description: FAIL NEXT skips failed iterations at iteration level
    commands:
      - rd run for-next-at-iteration.runbook.md
    result: COMPLETE
---

# FOR Next At Iteration Level

## 1. Process items

- FOR item IN 1 TO 3
  - FAIL: NEXT
- PASS ANY: COMPLETE
- FAIL ALL: STOP

### 1.1 Attempt {{item}}

```bash
rd echo --result fail --result pass --result pass
```
