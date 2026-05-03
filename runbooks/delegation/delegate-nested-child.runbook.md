---
name: delegate-nested-child
description: Child runbook that composes a grandchild via rd run
tags:
  - delegation
scenarios:
  completed:
    description: Child composes the grandchild runbook and completes
    commands:
      - rd run delegate-nested-child.runbook.md
    result: COMPLETE
---

# Delegate Nested Child

## 1. Child work

- PASS ALL COMPLETE
- FAIL ANY STOP

### 1.1 Grandchild task

Compose the grandchild runbook inline.

```bash
rd run delegate-nested-grandchild.runbook.md
```
