---
name: delegate-nested
description: Single-level delegation where child composes grandchild inline
tags:
  - delegation
scenarios:
  all-pass:
    description: Single-level delegation; child composes grandchild inline
    commands:
      - rd run delegate-nested.runbook.md
      - rd delegate
      - rd claim ${TOKEN}
      - rd pass --claim-id ${CLAIM_ID}
    result: COMPLETE
---

# Delegate Nested

Parent runbook that delegates to a child, which composes the grandchild inline.

## 1. Parent work

- PASS ALL COMPLETE
- FAIL ANY STOP

### 1.1 Child task

- delegate-nested-child.runbook.md
