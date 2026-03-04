---
name: fail-any-await-three-substeps
description: FAIL ANY AWAIT with three substeps validates no short-circuit
tags:
  - transitions
  - await

scenarios:
  all-pass:
    description: All three substeps pass, PASS ALL fires COMPLETE
    commands:
      - rd run --prompted fail-any-await-three-substeps.runbook.md
      - rd pass
      - rd pass
      - rd pass
    result: COMPLETE
  first-fails-continues:
    description: First fails, AWAIT defers through all substeps, FAIL ANY fires STOP
    commands:
      - rd run --prompted fail-any-await-three-substeps.runbook.md
      - rd fail
      - rd pass
      - rd pass
    result: STOP
  middle-fails:
    description: Middle substep fails, AWAIT defers, FAIL ANY fires STOP
    commands:
      - rd run --prompted fail-any-await-three-substeps.runbook.md
      - rd pass
      - rd fail
      - rd pass
    result: STOP
  all-fail:
    description: All three substeps fail, FAIL ANY AWAIT fires STOP
    commands:
      - rd run --prompted fail-any-await-three-substeps.runbook.md
      - rd fail
      - rd fail
      - rd fail
    result: STOP
---

# FAIL ANY AWAIT Three Substeps

Three substeps with AWAIT validate no short-circuit at any point.

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

### 1.3 Third check

```bash
rd echo "third"
```
