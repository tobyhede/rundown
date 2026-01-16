---
name: runbook-composition
description: Demonstrates composing multiple child workflows to verify lint, types, and tests all pass

scenarios:
  completed:
    description: Tests successful completion when all child workflows pass
    commands:
      - rd run --prompted runbook-composition.runbook.md
      - rd pass
      - rd pass
      - rd pass
    result: COMPLETE

  child-fails:
    description: Tests failure when a child workflow fails
    commands:
      - rd run --prompted runbook-composition.runbook.md
      - rd fail
    result: STOP
tags:
  - composition
---

## 1. Verify
- FAIL ANY: STOP "Verification failed"
- lint.runbook.md
- types.runbook.md
- tests.runbook.md

