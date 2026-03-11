---
name: for-file-source
description: FOR loop iterating over a file data source
tags:
  - for-loops
scenarios:
  completed:
    description: Iterates three lines from text file
    commands:
      - rd run --var-file data/sources.yaml for-file-source.runbook.md
    result: COMPLETE
---

# FOR File Source

## 1. Process file items

- FOR item IN {{ items }}
- PASS ALL COMPLETE

### 1.1 Handle {{item}}

```bash
rd echo "item={{item}}"
```
