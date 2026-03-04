---
name: context-current
description: Context current variables reflect execution position
tags:
  - variables
scenarios:
  completed:
    description: Context position variables echo from substep
    commands:
      - rd run context-current.runbook.md
    result: COMPLETE
---

# Context Current

## 1. Check position

- PASS ALL: COMPLETE

### 1.1 Echo context

```bash
rd echo "step={{context.current.step}} substep={{context.current.substep}} at={{context.current.at}}"
```
