---
name: for-explicit-defer
description: Explicit DEFER at FOR iteration level accumulates results for parent aggregation
tags:
  - for-loops
scenarios:
  completed:
    description: All iterations DEFER results, PASS ALL fires COMPLETE
    commands:
      - rd run for-explicit-defer.runbook.md
    result: COMPLETE
---

# FOR Explicit DEFER

FOR iteration-level transitions default to DEFER. These two forms are equivalent:
- Bare FOR clause (no nested transitions) — implicit DEFER
- Explicit `- PASS: DEFER` / `- FAIL: DEFER` nested under FOR

## 1. Validate items

- FOR item IN 1 TO 3
  - PASS: DEFER
  - FAIL: DEFER
- PASS ALL: COMPLETE
- FAIL ANY: STOP

### 1.1 Check {{item}}

```bash
rd echo "item={{item}}"
```
