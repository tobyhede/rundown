---
name: step-runbook-list
description: Demonstrates composing multiple child workflows to verify lint, types, and tests all pass

scenarios:
  completed:
    description: Tests successful completion when all child workflows pass
    commands:
      - rd run --prompted step-runbook-list.runbook.md
      - rd pass
      - rd pass
      - rd pass
    result: COMPLETE

  child-fails:
    description: Tests failure when a child workflow fails
    commands:
      - rd run --prompted step-runbook-list.runbook.md
      - rd fail
      - rd pass
      - rd pass
    result: STOP
tags:
  - composition
---

Step-level runbook list shorthand below is equivalent to `### 1.1` with the same runbook list.

## 1. Verify
- FAIL ANY: STOP "Verification failed"
- lint.runbook.md
- types.runbook.md
- tests.runbook.md
