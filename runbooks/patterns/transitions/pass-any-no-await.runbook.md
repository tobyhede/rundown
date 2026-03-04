---
name: pass-any-no-await
description: PASS ANY without AWAIT demonstrates pass-fast short-circuit
tags:
  - transitions
  - await

scenarios:
  first-passes-short-circuits:
    description: First passes, PASS ANY short-circuits to COMPLETE immediately
    commands:
      - rd run --prompted pass-any-no-await.runbook.md
      - rd pass
    result: COMPLETE
  all-fail:
    description: All substeps fail, FAIL ALL fires STOP
    commands:
      - rd run --prompted pass-any-no-await.runbook.md
      - rd fail
      - rd fail
    result: STOP
---

# PASS ANY Without AWAIT

Contrast with PASS ANY AWAIT. Without AWAIT, first pass short-circuits to COMPLETE.

## 1. Pass-fast check

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
