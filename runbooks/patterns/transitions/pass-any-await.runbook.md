---
name: pass-any-await
description: PASS ANY AWAIT deferred optimistic aggregation
tags:
  - transitions
  - await

scenarios:
  all-pass:
    description: All substeps pass, PASS ANY AWAIT fires COMPLETE
    commands:
      - rd run --prompted pass-any-await.runbook.md
      - rd pass
      - rd pass
    result: COMPLETE
  first-passes-deferred:
    description: First passes but AWAIT defers, second fails, still COMPLETE
    commands:
      - rd run --prompted pass-any-await.runbook.md
      - rd pass
      - rd fail
    result: COMPLETE
  all-fail:
    description: All substeps fail, FAIL ALL fires STOP
    commands:
      - rd run --prompted pass-any-await.runbook.md
      - rd fail
      - rd fail
    result: STOP
---

# PASS ANY AWAIT

PASS ANY AWAIT defers pass evaluation until all substeps complete.
Without AWAIT, first pass would short-circuit to COMPLETE.

## 1. Deferred optimistic check

- PASS ANY AWAIT: COMPLETE
- FAIL ALL: STOP "All checks failed"

### 1.1 First check

```bash
rd echo "first"
```

### 1.2 Second check

```bash
rd echo "second"
```
