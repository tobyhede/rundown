---
name: var-json-array
description: Inline JSON array via --input-json drives FOR loop iteration
tags:
  - variables
  - for-loops
scenarios:
  completed:
    description: JSON array passed via --input-json drives FOR loop
    commands:
      - rd run --input-json 'items=["alpha","bravo","charlie"]' var-json-array.runbook.md
    result: COMPLETE
---

# JSON Array Source

## 1. Process items

- FOR item IN {{ items }}
- PASS ALL COMPLETE
- FAIL ANY STOP

### 1.1 Handle {{item}}

```bash
rd echo "item={{item}}"
```
