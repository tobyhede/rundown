---
name: delegate-nested
description: Multi-level delegation with parent, child, and grandchild
tags:
  - delegation
scenarios:
  all-pass:
    description: Three-level delegation chain completes
    commands:
      - rd run delegate-nested.runbook.md
      - rd delegate delegate-nested-child.runbook.md --step 1.1
      - rd claim ${TOKEN}
      - rd delegate delegate-nested-grandchild.runbook.md --step 1.1
      - rd claim ${TOKEN_2}
    result: COMPLETE
---

# Delegate Nested

Parent runbook that delegates to a child, which delegates to a grandchild.

## 1. Parent work

- PASS ALL COMPLETE
- FAIL ANY STOP

### 1.1 Child task

Delegated to a child runbook.
