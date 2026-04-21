---
name: for-prompted-fallback
description: FOR loop falls back to prompted-for when bounds are unresolved
tags:
  - for-loops
scenarios:
  prompted:
    description: Unresolved variable demotes FOR to prompted-for, agent passes manually
    commands:
      - rd run for-prompted-fallback.runbook.md
      - rd pass
    result: COMPLETE
  resolved:
    description: Variable bounds expand at parse time, FOR iterates normally
    commands:
      - rd run --input N=2 for-prompted-fallback.runbook.md
    result: COMPLETE
---

# FOR Prompted Fallback

## 1. Process items

- FOR item IN 1 TO {{N}}
- PASS ALL COMPLETE
- FAIL ANY STOP

### 1.1 Handle {{item}}

```bash
rd echo "item={{item}}"
```
