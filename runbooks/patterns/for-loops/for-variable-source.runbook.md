---
name: FOR Variable Source
description: FOR loop iterating over a variable data source.
tags:
  - for-loops
scenarios:
  completed:
    description: All items from data source are processed
    commands:
      - rd run --var items=alpha,beta,gamma for-variable-source.runbook.md
    result: COMPLETE
---

# FOR Variable Source

## 1. Process items
- FOR item IN {{ items }}
- PASS ALL: COMPLETE
### 1.1 Handle {{item}}
```bash
rd echo "item={{item}}"
```
