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
      - rd pass
      - rd fail
    result: COMPLETE
  all-fail:
    description: All substeps fail, FAIL ALL fires STOP
    commands:
      - rd run --prompted pass-any.runbook.md
      - rd fail
      - rd fail
    result: STOP
---

# PASS ANY

Aggregation waits for all DEFER'd results before evaluating. Any pass triggers COMPLETE.

## 1. Check any item

- PASS ANY: COMPLETE
- FAIL ALL: STOP "All checks failed"

### 1.1 First check

```bash
rd echo "first"
```

### 1.2 Second check

```bash
rd echo "second"
```
