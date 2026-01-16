---
name: metadata-header
description: Runbook with H1 title and description text
tags:
  - features

scenarios:
  completed:
    description: Frontmatter is parsed and displayed
    commands:
      - rd run --prompted metadata-header.runbook.md
      - rd pass
      - rd pass
    result: COMPLETE
---

# Runbook Title
This is a description of the runbook.

## 1. First Step
- PASS: CONTINUE
- FAIL: STOP

Execute.

## 2. Second Step
- PASS: COMPLETE
- FAIL: STOP

Process.
