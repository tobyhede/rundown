---
name: for-unnamed
description: Unnamed FOR loop without a loop variable
tags:
  - for-loops
scenarios:
  unnamed-range:
    description: Unnamed FOR 1 TO 3 iterates using Index variable
    commands:
      - rd run for-unnamed.runbook.md
    result: COMPLETE
---

# FOR Unnamed

## 1. Iterate unnamed range

- FOR 1 TO 3
- PASS ALL COMPLETE
- FAIL ANY STOP

### 1.1 Step {{Index}}

```bash
rd echo "index={{Index}}"
```
