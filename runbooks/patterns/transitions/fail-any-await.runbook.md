---
name: fail-any-await
description: FAIL ANY AWAIT deferred pessimistic aggregation
tags:
  - transitions
  - await

scenarios:
  all-pass:
    description: All substeps pass, PASS ALL fires COMPLETE
    commands:
      - rd run --prompted fail-any-await.runbook.md
      - rd pass
      - rd pass
    result: COMPLETE
  first-fails-deferred:
    description: First fails, AWAIT defers to second, but FAIL ANY still fires STOP
    commands:
      - rd run --prompted fail-any-await.runbook.md
      - rd fail
      - rd pass
    result: STOP
  all-fail:
    description: All substeps fail, FAIL ANY AWAIT fires STOP
    commands:
      - rd run --prompted fail-any-await.runbook.md
      - rd fail
      - rd fail
    result: STOP
---

# FAIL ANY AWAIT

FAIL ANY AWAIT defers failure evaluation until all substeps complete.
Without AWAIT, first failure would short-circuit to STOP.

## 1. Deferred pessimistic check

- PASS ALL: COMPLETE
- FAIL ANY AWAIT: STOP "A check failed"

### 1.1 First check

```bash
rd echo "first"
```

### 1.2 Second check

```bash
rd echo "second"
```
