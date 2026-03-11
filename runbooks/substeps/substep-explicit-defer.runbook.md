---
name: substep-explicit-defer
description: Explicit DEFER on substeps propagates results to parent aggregation
tags:
  - substeps
scenarios:
  completed:
    description: Both substeps DEFER, parent PASS ALL fires COMPLETE
    commands:
      - rd run substep-explicit-defer.runbook.md
    result: COMPLETE
---

# Substep Explicit DEFER

Substeps under aggregation default to DEFER. These two forms are equivalent:
- Bare substep (no transitions) — implicit DEFER
- Explicit `- PASS DEFER` / `- FAIL DEFER`

## 1. Validate

- PASS ALL COMPLETE
- FAIL ANY STOP

### 1.1 First check

- PASS DEFER
- FAIL DEFER

```bash
rd echo "first"
```

### 1.2 Second check (implicit DEFER — equivalent)

```bash
rd echo "second"
```
