---
name: pass-any
description: PASS ANY completes when any substep passes (after all complete)
tags:
  - transitions

scenarios:
  first-passes:
    description: First passes, second fails, PASS ANY fires COMPLETE
    commands:
      - rd run --prompted pass-any.runbook.md
      - rd pass --token ${TOKEN} --step 1.1
      - rd fail --token ${TOKEN} --step 1.2
    result: COMPLETE
  all-fail:
    description: All substeps fail, FAIL ALL fires STOP
    commands:
      - rd run --prompted pass-any.runbook.md
      - rd fail --token ${TOKEN} --step 1.1
      - rd fail --token ${TOKEN} --step 1.2
    result: STOP
---

# PASS ANY

Aggregation waits for all DEFER'd results before evaluating. Any pass triggers COMPLETE.

## 1. Check any item

- PASS ANY COMPLETE
- FAIL ALL STOP "All checks failed"

### 1.1 First check

```bash
rd echo "first"
```

### 1.2 Second check

```bash
rd echo "second"
```
