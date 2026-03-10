---
name: for-substep-all-continue
description: All substeps use CONTINUE producing vacuous pass with no deferred results
tags:
  - for-loops
scenarios:
  vacuous-pass:
    description: No DEFER substeps means empty deferredResults, vacuous pass propagates
    commands:
      - rd run for-substep-all-continue.runbook.md
    result: COMPLETE
  all-fail-vacuous:
    description: All substeps fail but CONTINUE is invisible, vacuous pass still propagates
    commands:
      - rd run --prompted for-substep-all-continue.runbook.md
      - rd fail
      - rd fail
      - rd fail
      - rd fail
      - rd pass
    result: COMPLETE
---

# FOR All CONTINUE Substeps

When every substep uses CONTINUE, no results feed iteration aggregation.
This produces a vacuous pass (empty deferredResults → pass by default).

## 1. Process items

- FOR item IN 1 TO 2
- PASS ALL: CONTINUE
- FAIL ANY: STOP

### 1.1 Check {{item}}

- PASS: CONTINUE
- FAIL: CONTINUE

```bash
rd echo "check={{item}}"
```

### 1.2 Log {{item}}

- PASS: CONTINUE
- FAIL: CONTINUE

```bash
rd echo "log={{item}}"
```

## 2. Done

- PASS: COMPLETE

```bash
rd echo "done"
```
