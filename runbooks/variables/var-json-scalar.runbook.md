---
name: var-json-scalar
description: Inline JSON scalar via --var-json sets template variable
tags:
  - variables
scenarios:
  completed:
    description: JSON number passed via --var-json is used as template variable
    commands:
      - rd run --var-json count=42 var-json-scalar.runbook.md
    result: COMPLETE
---

# JSON Scalar

## 1. Echo count

- PASS COMPLETE

```bash
rd echo "count={{count}}"
```
