---
name: for-range-dotdot
description: FOR loop using 1..5 implicit range syntax.
tags:
  - for-loops
scenarios:
  completed:
    description: All five iterations pass and runbook completes
    commands:
      - rd run for-range-dotdot.runbook.md
    result: COMPLETE
---

# FOR Range DotDot

## 1. Process items
- FOR item IN 1..5
- PASS ALL: COMPLETE
### 1.1 Process {{item}}
```bash
rd echo "item={{item}}"
```
