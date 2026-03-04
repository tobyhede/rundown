---
name: delegate-nested-child
description: Child runbook that delegates to a grandchild
tags:
  - delegation
scenarios:
  completed:
    description: Child delegates to grandchild and completes
    commands:
      - rd run delegate-nested-child.runbook.md
      - rd delegate delegate-nested-grandchild.runbook.md --step 1.1
      - rd claim ${TOKEN}
    result: COMPLETE
---

# Delegate Nested Child

## 1. Child work

- PASS ALL COMPLETE
- FAIL ANY STOP

### 1.1 Grandchild task

Delegated to a grandchild runbook.
