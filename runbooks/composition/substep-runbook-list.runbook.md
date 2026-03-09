---
name: substep-runbook-list
description: Demonstrates runbook references within substeps

scenarios:
  basic:
    description: Child runbooks execute within substeps
    commands:
      - rd run --prompted substep-runbook-list.runbook.md
      - rd pass
      - rd pass
    result: COMPLETE
tags:
  - composition
  - substeps
---

# Substep Runbooks

Explicit substep form for runbook references
(equivalent to step-level runbook-list shorthand).

## 1. Verification Suite

### 1.1 Lint Check

- FAIL ANY: STOP "Lint failed"

- child-task.runbook.md

### 1.2 Type Check

- FAIL ANY: STOP "Types failed"

- child-task.runbook.md
