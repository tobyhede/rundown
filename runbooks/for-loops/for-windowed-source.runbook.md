---
name: for-windowed-source
description: FOR loop with windowed data source slice
tags:
  - for-loops
scenarios:
  completed:
    description: Window selects first 2 of 3 items
    commands:
      - rd run --var-file data/array-sources.yaml for-windowed-source.runbook.md
    result: COMPLETE
---

# FOR Windowed Source

## 1. Process window

- FOR item IN 1 TO 2 OF {{ items }}
- PASS ALL COMPLETE
- FAIL ANY STOP

### 1.1 Handle {{item}}

```bash
rd echo "item={{item}}"
```
