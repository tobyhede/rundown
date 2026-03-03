---
name: for-runbook-list
description: FOR-annotated step with runbook list as substeps
tags:
  - for-loops
scenarios:
  completed:
    description: FOR iterates with runbook list providing implicit substeps
    commands:
      - rd run --prompted for-runbook-list.runbook.md
      - rd pass
      - rd pass
      - rd pass
    result: COMPLETE
---

# FOR Runbook List

## 1. Process tasks

- FOR item IN 1 TO 3
- PASS ALL: COMPLETE

### 1.1 Task {{item}}

```bash
rd echo "task={{item}}"
```
