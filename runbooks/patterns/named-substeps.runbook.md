---
name: named-substeps
description: Demonstrates named substeps within a parent step

scenarios:
  success:
    description: All substeps complete successfully
    commands:
      - rd run --prompted named-substeps.runbook.md
      - rd pass
      - rd pass
      - rd pass
    result: COMPLETE
---

# Named Substeps Example

## 1. Main step
### 1.1 Prepare
Execute first action.
### 1.2 Run
Execute second action.
### 1.Cleanup Cleanup
- PASS: COMPLETE
- FAIL: STOP "Cleanup failed"

Clean up resources