---
name: for-implicit-start
description: FOR loop with implicit start iterates 1 to N
tags:
  - for-loops
scenarios:
  completed:
    description: Implicit range iterates 1, 2, 3
    commands:
      - rd run for-implicit-start.runbook.md
    result: COMPLETE
---

# FOR Implicit Start

## 1. Process items

- FOR item IN 3
- PASS ALL COMPLETE

### 1.1 Handle {{item}}

```bash
rd echo "item={{item}}"
```
