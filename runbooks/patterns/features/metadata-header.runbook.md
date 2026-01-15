---
name: metadata-header
description: Workflow with H1 title and description text

scenarios:
  completed:
    description: Frontmatter is parsed and displayed
    commands:
      - rd run --prompted metadata-header.runbook.md
      - rd pass
    result: COMPLETE
tags:
  - features
---

# Workflow Title
This is a description of the workflow.

## 1. First Step
Execute.

## 2. Second Step
Process.
