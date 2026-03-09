---
name: for-substep-three-mixed
description: Three substeps mixing DEFER and CONTINUE in various positions
tags:
  - for-loops
scenarios:
  all-pass:
    description: All iterations pass all substeps, only DEFER substeps feed aggregation
    commands:
      - rd run for-substep-three-mixed.runbook.md
    result: COMPLETE
  middle-continue-fails:
    description: Middle CONTINUE substep fails, surrounding DEFER substeps pass
    commands:
      - rd run --prompted for-substep-three-mixed.runbook.md
      - rd pass
      - rd fail
      - rd pass
      - rd pass
      - rd fail
      - rd pass
      - rd pass
    result: COMPLETE
---

# FOR Three Substeps Mixed

Three substeps per iteration: DEFER, CONTINUE, DEFER.
The middle CONTINUE substep is invisible to aggregation.
Both DEFER substeps feed iteration results.

## 1. Process items

- FOR item IN 1 TO 2
- PASS ALL: CONTINUE
- FAIL ANY: STOP

### 1.1 Prepare {{item}}

- PASS: DEFER
- FAIL: DEFER

```bash
rd echo "prepare={{item}}"
```

### 1.2 Notify {{item}}

- PASS: CONTINUE
- FAIL: CONTINUE

```bash
rd echo "notify={{item}}"
```

### 1.3 Finalize {{item}}

- PASS: DEFER
- FAIL: DEFER

```bash
rd echo "finalize={{item}}"
```

## 2. Done

- PASS: COMPLETE

```bash
rd echo "done"
```
