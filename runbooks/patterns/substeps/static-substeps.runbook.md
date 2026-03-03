---
name: static-substeps
description: Static nested substeps with implicit transitions

scenarios:
  completed:
    description: Tests completing all static substeps in sequence
    commands:
      - rd run --prompted static-substeps.runbook.md
      - rd pass
      - rd pass
    result: COMPLETE
tags:
  - substeps
---

## 1. Parent

### 1.1 Static Child

Content.

### 1.2 Another Child

Content.
