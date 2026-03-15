---
name: for-retry-in-iteration
description: RETRY within a FOR loop iteration
tags:
  - for-loops
scenarios:
  after-retry:
    description: Each iteration fails once then passes on retry
    commands:
      - rd run for-retry-in-iteration.runbook.md
    result: COMPLETE
---

# FOR Retry In Iteration

## 1. Process items

- FOR item IN 1 TO 2
- PASS ALL COMPLETE
- FAIL ANY STOP

### 1.1 Attempt {{item}}

- PASS CONTINUE
- FAIL RETRY 2 STOP

```bash
rd echo --result fail --result pass
```
