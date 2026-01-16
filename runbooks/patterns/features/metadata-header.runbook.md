---
name: metadata-header
description: Runbook with H1 title and description text

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

# Runbook Title
This is a description of the runbook.

## 1. First Step
Execute.

## 2. Second Step
Process.
