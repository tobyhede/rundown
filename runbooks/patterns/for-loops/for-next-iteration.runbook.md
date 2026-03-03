---
name: for-next-iteration
description: FOR loop iteration advancement in prompted mode.
tags:
  - for-loops
scenarios:
  completed:
    description: All three iterations pass via prompted mode
    commands:
      - rd run --prompted for-next-iteration.runbook.md
      - rd pass
      - rd pass
      - rd pass
    result: COMPLETE
---

# FOR Next Iteration

## 1. Iterate items

- FOR item IN 1 TO 3
- PASS ALL: COMPLETE

### 1.1 Handle iteration {{item}}

```bash
rd echo "iteration={{item}}"
```
