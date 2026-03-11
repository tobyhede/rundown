---
name: all-modifier
description: PASS ALL aggregate modifier (pessimistic strategy)
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
  one-fails-stopped:
    description: One substep fails, FAIL ANY fires STOP
    commands:
      - rd run --prompted all-modifier.runbook.md
      - rd fail
      - rd pass
    result: STOP
  auto-execution:
    description: All substeps auto-execute and pass
    commands:
      - rd run all-modifier.runbook.md
    result: COMPLETE
---

# ALL Modifier

PASS ALL requires all substeps to pass. Paired with FAIL ANY (pessimistic).

## 1. Aggregated check

- PASS ALL COMPLETE
- FAIL ANY STOP "A check failed"

### 1.1 First check

```bash
rd echo "check one"
```

### 1.2 Second check

```bash
rd echo "check two"
```
