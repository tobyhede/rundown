---
name: for-iteration-retry
description: RETRY as an iteration-level transition within a FOR loop
tags:
  - for-loops
scenarios:
  after-retry:
    description: Each iteration fails once then passes on retry via iteration-level RETRY
    commands:
      - rd run for-iteration-retry.runbook.md
    result: COMPLETE
---

# FOR Iteration Retry

## 1. Process items

- FOR item IN 1 TO 2
  - FAIL RETRY 1 CONTINUE
- PASS ALL COMPLETE
- FAIL ANY STOP

### 1.1 Attempt {{item}}

```bash
rd echo --result fail --result pass
```
