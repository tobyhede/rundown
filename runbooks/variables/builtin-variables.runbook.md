---
name: builtin-variables
description: Built-in runtime variables expand at execution time
tags:
  - variables
scenarios:
  completed:
    description: Built-in variables echo their runtime values
    commands:
      - rd run builtin-variables.runbook.md
    result: COMPLETE
---

# Built-in Variables

## 1. Echo built-ins

- PASS COMPLETE

```bash
rd echo "date={{Date}} year={{Year}} step={{Step}} workpath={{WorkPath}}"
```
