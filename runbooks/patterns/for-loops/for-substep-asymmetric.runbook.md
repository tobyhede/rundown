---
name: for-substep-asymmetric
description: Substep with PASS CONTINUE and FAIL DEFER - asymmetric transition routing
tags:
  - for-loops
scenarios:
  all-pass-invisible:
    description: All substeps pass via CONTINUE, invisible to aggregation, vacuous pass
    commands:
      - rd run for-substep-asymmetric.runbook.md
    result: COMPLETE
  fail-feeds-aggregation:
    description: Both substeps fail via DEFER, FAIL ANY triggers STOP
    commands:
      - rd run --prompted for-substep-asymmetric.runbook.md
      - rd fail
      - rd fail
    result: STOP
---

# FOR Substep Asymmetric Transitions

Substep uses PASS: CONTINUE (invisible) but FAIL: DEFER (feeds aggregation).
This creates asymmetric routing where success is silent but failure is recorded.

## 1. Process items

- FOR item IN 1 TO 2
- PASS ALL: CONTINUE
- FAIL ANY: STOP

### 1.1 Validate {{item}}

- PASS: CONTINUE
- FAIL: DEFER

```bash
rd echo "validate={{item}}"
```

## 2. Done

- PASS: COMPLETE

```bash
rd echo "done"
```
