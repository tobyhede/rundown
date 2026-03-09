---
name: for-break-on-pass
description: PASS BREAK exits the loop early when a substep passes.
tags:
  - for-loops
scenarios:
  break-on-second:
    description: First iteration fails, second passes and breaks, step completes
    commands:
      - rd run --prompted for-break-on-pass.runbook.md
      - rd fail
      - rd pass
    result: COMPLETE
---

# FOR Break On Pass

## 1. Find match

- FOR item IN 1 TO 3
- PASS ANY: COMPLETE

### 1.1 Try {{item}}

- PASS: BREAK
- FAIL: CONTINUE

```bash
rd echo "item={{item}}"
```
