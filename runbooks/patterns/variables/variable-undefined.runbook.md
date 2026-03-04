---
name: variable-undefined
description: Undefined variables preserved as literal text
tags:
  - variables
scenarios:
  completed:
    description: Undefined variable stays as literal string in output
    commands:
      - rd run variable-undefined.runbook.md
    result: COMPLETE
---

# Variable Undefined

## 1. Echo undefined

- PASS COMPLETE

```bash
rd echo "value={{undefined_var}}"
```
