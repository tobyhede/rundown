---
name: for-defer-shorthand
description: DEFER shorthand at FOR iteration level
tags:
  - for-loops
scenarios:
  completed:
    description: All iterations DEFER via shorthand, PASS ALL fires COMPLETE
    commands:
      - rd run for-defer-shorthand.runbook.md
    result: COMPLETE
---

# FOR DEFER Shorthand

`- DEFER` under FOR clause is shorthand for `- PASS DEFER` + `- FAIL DEFER`.

## 1. Validate items

- FOR item IN 1 TO 3
  - DEFER
- PASS ALL COMPLETE
- FAIL ANY STOP

### 1.1 Check {{item}}

```bash
rd echo "item={{item}}"
```
