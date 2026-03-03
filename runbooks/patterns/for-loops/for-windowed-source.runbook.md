---
name: for-windowed-source
description: FOR loop with windowed data source slice
tags:
  - for-loops
scenarios:
  completed:
    description: Window selects first 2 of 3 items
    commands:
      - rd run --var items=alpha,beta,gamma for-windowed-source.runbook.md
    result: COMPLETE
---

# FOR Windowed Source

## 1. Process window

- FOR item IN 1 TO 2 OF {{ items }}
- PASS ALL: COMPLETE

### 1.1 Handle {{item}}

```bash
rd echo "item={{item}}"
```
