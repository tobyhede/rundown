---
name: step-runbook-list
description: Compose child workflows with step-level runbook list

scenarios:
  completed:
    description: All child workflows pass
    commands:
      - rd run --prompted step-runbook-list.runbook.md
      - rd pass
      - rd pass
      - rd pass
    result: COMPLETE

  child-fails:
    description: Child workflow fails, runbook stops
    commands:
      - rd run --prompted step-runbook-list.runbook.md
      - rd fail
      - rd pass
      - rd pass
    result: STOP
tags:
  - composition
---

Step-level runbook list shorthand below is equivalent
to `### 1.1` with the same runbook list.

## 1. Verify

- FAIL ANY STOP "Verification failed"
- lint.runbook.md
- types.runbook.md
- tests.runbook.md
