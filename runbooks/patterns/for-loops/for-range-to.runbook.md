---
name: FOR Range TO
description: FOR loop using 1 TO 5 range syntax with five iterations.
tags:
  - for-loops
scenarios:
  completed:
    description: All five iterations pass and runbook completes
    commands:
      - rd run for-range-to.runbook.md
    result: COMPLETE
---

# FOR Range TO

## 1. Process items
- FOR item IN 1 TO 5
- PASS ALL: COMPLETE
### 1.1 Process {{item}}
```bash
rd echo "item={{item}}"
```
