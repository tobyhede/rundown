---
name: for-variable-source
description: FOR loop iterating over a variable data source.
tags:
  - for-loops
scenarios:
  completed:
    description: All items from data source are processed
    commands:
      - rd run --var-file data/array-sources.yaml for-variable-source.runbook.md
    result: COMPLETE
---

# FOR Variable Source

## 1. Process items

- FOR item IN {{ items }}
- PASS ALL COMPLETE
- FAIL ANY STOP

### 1.1 Handle {{item}}

```bash
rd echo "item={{item}}"
```
