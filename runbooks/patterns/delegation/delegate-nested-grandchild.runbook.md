---
name: delegate-nested-grandchild
description: Grandchild runbook that auto-completes as delegation leaf
tags:
  - delegation
scenarios:
  auto-pass:
    description: Grandchild auto-executes and completes
    commands:
      - rd run delegate-nested-grandchild.runbook.md
    result: COMPLETE
---

# Delegate Nested Grandchild

## 1. Execute grandchild task

- PASS: COMPLETE
- FAIL: STOP

```bash
rd echo "grandchild completed"
```
