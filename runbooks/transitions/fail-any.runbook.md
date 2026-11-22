---
name: fail-any
description: FAIL ANY stops when any substep fails (after all complete)
tags:
  - transitions

scenarios:
  all-pass:
    description: All substeps pass, PASS ALL fires COMPLETE
    commands:
      - rd run --prompted fail-any.runbook.md
      - rd pass --token ${TOKEN} --step 1.1
      - rd pass --token ${TOKEN} --step 1.2
    result: COMPLETE
  first-fails:
    description: First fails, second passes, FAIL ANY fires STOP
    commands:
      - rd run --prompted fail-any.runbook.md
      - rd fail --token ${TOKEN} --step 1.1
      - rd pass --token ${TOKEN} --step 1.2
    result: STOP
---

# FAIL ANY

Aggregation waits for all DEFER'd results before evaluating. Any failure triggers STOP.

## 1. Check all items

- PASS ALL COMPLETE
- FAIL ANY STOP "A check failed"

### 1.1 First check

```bash
rd echo "first"
```

### 1.2 Second check

```bash
rd echo "second"
```
