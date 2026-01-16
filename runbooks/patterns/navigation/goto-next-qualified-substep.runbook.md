---
name: goto-next-qualified-substep
description: Demonstrates explicitly advancing to the next dynamic substep using GOTO NEXT X.{n} syntax for substep-level navigation

scenarios:
  item-failure:
    description: Processing item fails and stops runbook
    commands:
      - rd run --prompted goto-next-qualified-substep.runbook.md
      - rd fail
    result: STOP
tags:
  - navigation
  - substeps
---

# GOTO NEXT X.{n} - Explicit Substep Advancement

Demonstrates explicitly advancing dynamic substep.

## 1. Static Step with Dynamic Substeps

### 1.{n} Process Item
- PASS: GOTO NEXT 1.{n}
- FAIL: STOP

```bash
rd echo --result pass --result fail
```

