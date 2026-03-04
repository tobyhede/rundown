---
name: fail-any-no-await
description: FAIL ANY without AWAIT demonstrates fail-fast short-circuit
tags:
  - transitions
  - await

scenarios:
  all-pass:
    description: All substeps pass, PASS ALL fires COMPLETE
    commands:
      - rd run --prompted fail-any-no-await.runbook.md
      - rd pass
      - rd pass
    result: COMPLETE
  first-fails-short-circuits:
    description: First fails, FAIL ANY short-circuits to STOP immediately
    commands:
      - rd run --prompted fail-any-no-await.runbook.md
      - rd fail
    result: STOP
---

# FAIL ANY Without AWAIT

Contrast with FAIL ANY AWAIT. Without AWAIT, first failure short-circuits to STOP.

## 1. Fail-fast check

- PASS ALL: COMPLETE
- FAIL ANY: STOP "A check failed"

### 1.1 First check

```bash
rd echo "first"
```

### 1.2 Second check

```bash
rd echo "second"
```
