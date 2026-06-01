---
name: substep-runbook-list
description: Demonstrates runbook references within substeps

scenarios:
  basic:
    description: Child runbooks execute within substeps
    commands:
      - rd check inline-child-pass.runbook.md
      - rd run substep-runbook-list.runbook.md
    result: COMPLETE
    expect:
      steps:
        - runbook: inline-child-pass.runbook.md
          from: "1"
          action: COMPLETE
          result: PASS
        - runbook: inline-child-pass.runbook.md
          from: "1"
          action: COMPLETE
          result: PASS
tags:
  - composition
  - substeps
---

# Substep Runbooks

Explicit substep form for runbook references
(equivalent to step-level runbook-list shorthand).

## 1. Verification Suite

### 1.1 Lint Check

- PASS ALL CONTINUE
- FAIL ANY STOP "Lint failed"

- inline-child-pass.runbook.md

### 1.2 Type Check

- PASS ALL CONTINUE
- FAIL ANY STOP "Types failed"

- inline-child-pass.runbook.md
