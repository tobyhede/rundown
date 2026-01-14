---
name: metadata-header
description: Workflow with H1 title and description text

scenarios:
  success:
    description: Complete workflow through both steps
    commands:
      - rd run --prompted metadata-header.runbook.md
      - rd pass
      - rd pass
    result: COMPLETE
---

# Workflow Title
This is a description of the workflow.

## 1. First Step
Execute.

## 2. Second Step
Process.
