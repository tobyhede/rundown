---
name: for-retry-loop-exhaust
description: RETRY exhaust with FOR-specific actions NEXT and BREAK
tags:
  - for-loops
scenarios:
  next-on-exhaust:
    description: RETRY exhaustion triggers NEXT to skip the iteration
    commands:
      - rd run for-retry-loop-exhaust.runbook.md
    result: COMPLETE
---

# FOR Retry Loop Exhaust

## 1. Process items

- FOR item IN 1 TO 3
- FAIL ANY CONTINUE

### 1.1 Attempt {{item}}

- PASS CONTINUE
- FAIL RETRY 1 NEXT

```bash
rd echo --result fail --result fail
```

## 2. Done

- PASS COMPLETE

```bash
rd echo "completed"
```
