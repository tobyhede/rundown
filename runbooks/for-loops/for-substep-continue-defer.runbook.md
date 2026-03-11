---
name: for-substep-continue-defer
description: CONTINUE substep followed by DEFER substep within FOR iteration
tags:
  - for-loops
scenarios:
  all-pass:
    description: All iterations pass both substeps, DEFER feeds aggregation, CONTINUE is invisible
    commands:
      - rd run for-substep-continue-defer.runbook.md
    result: COMPLETE
  continue-fails:
    description: CONTINUE substep fails but is invisible, DEFER substep passes
    commands:
      - rd run --prompted for-substep-continue-defer.runbook.md
      - rd fail
      - rd pass
      - rd fail
      - rd pass
      - rd pass
    result: COMPLETE
---

# FOR Substep CONTINUE then DEFER

CONTINUE substeps are invisible to iteration aggregation.
Only DEFER substeps feed results into the parent aggregation.

## 1. Process items

- FOR item IN 1 TO 2
- PASS ALL CONTINUE
- FAIL ANY STOP

### 1.1 Validate {{item}}

- PASS CONTINUE
- FAIL CONTINUE

```bash
rd echo "validate={{item}}"
```

### 1.2 Record {{item}}

- PASS DEFER
- FAIL DEFER

```bash
rd echo "record={{item}}"
```

## 2. Done

- PASS COMPLETE

```bash
rd echo "done"
```
