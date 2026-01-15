---
name: named-substeps
description: Demonstrates named substeps within a parent step

scenarios:
  completed:
    description: All named substeps pass
    commands:
      - rd run --prompted named-substeps.runbook.md
      - rd pass
      - rd pass
    result: COMPLETE
tags:
  - named
  - substeps
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