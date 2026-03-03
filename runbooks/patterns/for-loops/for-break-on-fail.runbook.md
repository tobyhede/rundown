---
name: for-break-on-fail
description: FAIL BREAK exits the loop early when a substep fails.
tags:
  - for-loops
scenarios:
  break-on-second:
    description: First iteration passes, second fails and breaks, continues to step 2
    commands:
      - rd run --prompted for-break-on-fail.runbook.md
      - rd pass
      - rd fail
      - rd pass
    result: COMPLETE
---

# FOR Break On Fail

## 1. Check items
- FOR item IN 1 TO 3
- FAIL ANY: CONTINUE
### 1.1 Validate {{item}}
- PASS: CONTINUE
- FAIL: BREAK

```bash
rd echo "item={{item}}"
```

## 2. Cleanup
- PASS: COMPLETE

```bash
rd echo "done"
```
