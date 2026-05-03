---
name: delegate-nested
description: Direct delegation to both child and grandchild via nested claims
tags:
  - delegation
scenarios:
  all-pass:
    description: Single-level delegation; child composes grandchild via rd run
    commands:
      - rd run delegate-nested.runbook.md
      - rd delegate
      - rd claim ${TOKEN}
    result: COMPLETE
---

# Delegate Nested

Parent runbook that delegates to a child, which delegates to a grandchild.

## 1. Parent work

- PASS ALL COMPLETE
- FAIL ANY STOP

### 1.1 Child task

Delegated to a child runbook.

- delegate-nested-child.runbook.md
