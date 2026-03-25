---
name: var-json-precedence
description: --var-json overrides --var for same key
tags:
  - variables
scenarios:
  override:
    description: --var-json wins over --var for same key
    commands:
      - rd run --var count=10 --var-json count=99 var-json-precedence.runbook.md
    result: COMPLETE
---

# JSON Precedence

## 1. Echo count

- PASS COMPLETE

```bash
rd echo "count={{count}}"
```
