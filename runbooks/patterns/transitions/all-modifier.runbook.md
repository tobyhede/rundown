---
name: all-modifier
description: PASS ALL and FAIL ALL aggregate modifiers
tags:
  - transitions

scenarios:
  completed:
    description: All substeps pass, PASS ALL fires
    commands:
      - rd run --prompted all-modifier.runbook.md
      - rd pass
      - rd pass
    result: COMPLETE
  auto-execution:
    description: All substeps auto-execute and pass
    commands:
      - rd run all-modifier.runbook.md
    result: COMPLETE
---

# ALL Modifier

PASS ALL requires all substeps to pass. FAIL ALL requires all to fail.

## 1. Aggregated check
- PASS ALL: COMPLETE
- FAIL ALL: STOP "All checks failed"

### 1.1 First check

```bash
rd echo "check one"
```

### 1.2 Second check

```bash
rd echo "check two"
```
