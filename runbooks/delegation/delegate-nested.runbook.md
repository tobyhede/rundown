---
name: delegate-nested
description: Single-level delegation where child completes without nested delegation
tags:
  - delegation
scenarios:
  all-pass:
    description: Single-level delegation; child completes and parent aggregates
    commands:
      - rd run delegate-nested.runbook.md
      - rd claim ${TOKEN}
    result: COMPLETE
---

# Delegate Nested

Parent runbook that delegates to a child.

## 1. Parent work

- DELEGATE
- PASS ALL COMPLETE
- FAIL ANY STOP

### 1.1 Child task

- DELEGATE
- delegate-nested-child.runbook.md
