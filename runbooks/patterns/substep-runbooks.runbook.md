---
name: substep-runbooks
description: Demonstrates runbook references within substeps

scenarios:
  basic:
    description: Tests successful execution of child runbooks referenced within substeps
    commands:
      - rd run --prompted substep-runbooks.runbook.md
      - rd pass
      - rd pass
    result: COMPLETE
---

# Substep Runbooks

Demonstrates referencing runbooks within substeps instead of at the step level.

## 1. Verification Suite

### 1.1 Lint Check
- FAIL ANY: STOP "Lint failed"

- child-task.runbook.md

### 1.2 Type Check
- FAIL ANY: STOP "Types failed"

- child-task.runbook.md
