---
name: for-default-transitions
description: FOR loop substeps with default transitions
tags:
  - for-loops
scenarios:
  completed:
    description: All iterations pass with implicit default transitions
    commands:
      - rd run for-default-transitions.runbook.md
    result: COMPLETE
---

# FOR Default Transitions

## 1. Process items

- FOR item IN 1 TO 2
- PASS ALL: COMPLETE

### 1.1 Handle {{item}}

```bash
rd echo "item={{item}}"
```
