---
name: var-json-precedence
description: --input-json overrides --input for same key
tags:
  - variables
scenarios:
  override:
    description: --input-json wins over --input for same key
    commands:
      - rd run --input count=10 --input-json count=99 var-json-precedence.runbook.md
    result: COMPLETE
---

# JSON Precedence

## 1. Echo count

- PASS COMPLETE

```bash
rd echo "count={{count}}"
```
