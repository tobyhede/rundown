---
name: for-variable-bounds
description: FOR loop with template-expanded bounds
tags:
  - for-loops
scenarios:
  completed:
    description: Variable bounds expand at parse time
    commands:
      - rd run --var Max=3 for-variable-bounds.runbook.md
    result: COMPLETE
---

# FOR Variable Bounds

## 1. Process items

- FOR item IN 1 TO {{Max}}
- PASS ALL COMPLETE

### 1.1 Handle {{item}}

```bash
rd echo "item={{item}}"
```
