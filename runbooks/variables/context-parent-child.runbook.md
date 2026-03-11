---
name: context-parent-child
description: Child runbook that echoes parent context variables
tags:
  - variables
scenarios:
  auto-pass:
    description: Child auto-executes and echoes parent context
    commands:
      - rd run context-parent-child.runbook.md
    result: COMPLETE
---

# Context Parent Child

## 1. Echo parent context

- PASS COMPLETE
- FAIL STOP

```bash
rd echo "parent-step={{context.parent.step}}"
```
