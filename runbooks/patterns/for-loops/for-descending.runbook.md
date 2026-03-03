---
name: for-descending
description: FOR loop with descending range iterates from high to low
tags:
  - for-loops
scenarios:
  completed:
    description: Descending range iterates 3, 2, 1
    commands:
      - rd run for-descending.runbook.md
    result: COMPLETE
---

# FOR Descending

## 1. Count down

- FOR item IN 3 TO 1
- PASS ALL: COMPLETE

### 1.1 Process {{item}}

```bash
rd echo "item={{item}}"
```
