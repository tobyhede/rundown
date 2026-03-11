---
name: delegate-with-vars-child
description: Child runbook that echoes variables passed via delegation
tags:
  - delegation
scenarios:
  auto_pass:
    description: Child auto-executes and echoes environment variable
    commands:
      - rd run --var environment=staging delegate-with-vars-child.runbook.md
    result: COMPLETE
---

# Delegate With Vars Child

## 1. Echo environment

- PASS COMPLETE
- FAIL STOP

```bash
rd echo "environment={{environment}}"
```
