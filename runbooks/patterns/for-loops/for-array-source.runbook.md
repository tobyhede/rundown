---
name: for-array-source
description: FOR loop iterating over a YAML array data source
tags:
  - for-loops
scenarios:
  completed:
    description: YAML array drives iteration
    commands:
      - rd run --var-file data/array-sources.yaml for-array-source.runbook.md
    result: COMPLETE
---

# FOR Array Source

## 1. Process array items

- FOR item IN {{ items }}
- PASS ALL: COMPLETE

### 1.1 Handle {{item}}

```bash
rd echo "item={{item}}"
```
