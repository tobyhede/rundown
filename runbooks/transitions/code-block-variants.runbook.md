---
name: code-block-variants
description: Code block info strings sh and shell execute while json is display-only
tags:
  - transitions
scenarios:
  completed:
    description: sh block executes and json block is display-only
    commands:
      - rd run --prompted code-block-variants.runbook.md
      - rd pass
      - rd pass
    result: COMPLETE
---

# Code Block Variants

## 1. Execute sh block

- PASS: CONTINUE

```sh
rd echo "sh block"
```

## 2. Display-only block

- PASS: COMPLETE

```json
{"status": "display-only"}
```
