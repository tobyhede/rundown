---
name: for-substep-defer-continue
description: DEFER substep followed by CONTINUE substep within FOR iteration
tags:
  - for-loops
scenarios:
  all-pass:
    description: All iterations pass, DEFER feeds aggregation, trailing CONTINUE is invisible
    commands:
      - rd run for-substep-defer-continue.runbook.md
    result: COMPLETE
  continue-fails:
    description: Trailing CONTINUE substep fails but result is invisible to aggregation
    commands:
      - rd run --prompted for-substep-defer-continue.runbook.md
      - rd pass
      - rd fail
      - rd pass
      - rd fail
      - rd pass
    result: COMPLETE
---

# FOR Substep DEFER then CONTINUE

Reversed order: DEFER first, CONTINUE second.
The DEFER substep feeds aggregation; the trailing CONTINUE is invisible.

## 1. Process items

- FOR item IN 1 TO 2
- PASS ALL CONTINUE
- FAIL ANY STOP

### 1.1 Record {{item}}

- PASS DEFER
- FAIL DEFER

```bash
rd echo "record={{item}}"
```

### 1.2 Verify {{item}}

- PASS CONTINUE
- FAIL CONTINUE

```bash
rd echo "verify={{item}}"
```

## 2. Done

- PASS COMPLETE

```bash
rd echo "done"
```
