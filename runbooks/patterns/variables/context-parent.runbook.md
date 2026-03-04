---
name: context-parent
description: Context parent variables accessible in delegated child
tags:
  - variables
scenarios:
  completed:
    description: Parent delegates and child echoes parent context
    commands:
      - rd run context-parent.runbook.md
      - rd delegate context-parent-child.runbook.md --step 1.1
      - rd claim ${TOKEN}
    result: COMPLETE
---

# Context Parent

## 1. Delegated work

- PASS ALL COMPLETE
- FAIL ANY STOP

### 1.1 Child task

Delegated to a child runbook that reads parent context.
