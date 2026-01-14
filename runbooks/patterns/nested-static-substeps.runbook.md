---
name: nested-static-substeps
description: Demonstrates static nested substeps without explicit transitions, showing hierarchical structure and implicit step completion.

scenarios:
  basic-completion:
    description: Tests completing all static substeps in sequence
    commands:
      - rd run --prompted nested-static-substeps.runbook.md
      - rd pass
      - rd pass
    result: COMPLETE
---

## 1. Parent

### 1.1 Static Child
Content.

### 1.2 Another Child
Content.
