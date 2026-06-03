---
name: delegate-nested-child
description: Child runbook that composes a grandchild inline
tags:
  - delegation
scenarios:
  completed:
    description: Child composes the grandchild runbook and completes
    commands:
      - rd run delegate-nested-child.runbook.md
    expect:
      result: COMPLETE
      entered:
        - at: "1.1"
          description: "Grandchild task"
      steps:
        - runbook: delegate-nested-grandchild.runbook.md
          from: "1"
          action: COMPLETE
          result: PASS
---

# Delegate Nested Child

## 1. Child work

- PASS ALL COMPLETE
- FAIL ANY STOP

### 1.1 Grandchild task

- delegate-nested-grandchild.runbook.md
