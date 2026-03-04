---
name: dot-named-substeps
description: Named substeps using dot-name syntax (1.Prepare, 1.Cleanup)
tags:
  - substeps

scenarios:
  completed:
    description: Pass both named substeps to complete
    commands:
      - rd run --prompted dot-named-substeps.runbook.md
      - rd pass
      - rd pass
    result: COMPLETE
---

# Named Substeps

Named substeps using dot-name syntax.

## 1. Parent

### 1.Prepare

- PASS CONTINUE
- FAIL STOP

```bash
rd echo "prepare"
```

### 1.Cleanup

- PASS COMPLETE

```bash
rd echo "cleanup"
```
