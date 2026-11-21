---
name: for-basic-substep
description: FOR-annotated step with basic substeps
tags:
  - for-loops
scenarios:
  completed:
    description: FOR iterates with substeps
    commands:
      - rd run --prompted for-basic-substep.runbook.md
      - rd pass --token ${TOKEN} --step 1.1 --index 1
      - rd pass --token ${TOKEN} --step 1.1 --index 2
      - rd pass --token ${TOKEN} --step 1.1 --index 3
    result: COMPLETE
---

# FOR Basic Substep

## 1. Process tasks

- FOR item IN 1 TO 3
- PASS ALL COMPLETE
- FAIL ANY STOP

### 1.1 Task {{item}}

```bash
rd echo "task={{item}}"
```
