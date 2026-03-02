---
name: any-modifier
description: PASS ANY and FAIL ANY aggregate modifiers
tags:
  - transitions

scenarios:
  completed:
    description: At least one substep passes, PASS ANY fires
    commands:
      - rd run --prompted any-modifier.runbook.md
      - rd pass
      - rd pass
    result: COMPLETE
  auto-execution:
    description: Substeps auto-execute, PASS ANY fires
    commands:
      - rd run any-modifier.runbook.md
    result: COMPLETE
---

# ANY Modifier

PASS ANY fires when at least one substep passes. FAIL ANY fires when at least one fails.

## 1. Optimistic check
- PASS ANY: COMPLETE
- FAIL ANY: STOP "A check failed"

### 1.1 Primary check

```bash
rd echo "primary"
```

### 1.2 Backup check

```bash
rd echo "backup"
```
