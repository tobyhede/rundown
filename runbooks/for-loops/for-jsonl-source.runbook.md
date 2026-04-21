---
name: for-jsonl-source
description: FOR loop iterating over JSONL data source with dotted field access
tags:
  - for-loops
scenarios:
  completed:
    description: Iterates JSON records using dotted field access
    commands:
      - rd run --input-file data/jsonl-sources.yaml for-jsonl-source.runbook.md
    result: COMPLETE
---

# FOR JSONL Source

## 1. Process records

- FOR item IN {{ records }}
- PASS ALL COMPLETE
- FAIL ANY STOP

### 1.1 Handle {{item.name}}

```bash
rd echo "name={{item.name}} role={{item.role}}"
```
