---
name: separator-syntax
description: Step number separator variants are all valid syntax
tags:
  - transitions
scenarios:
  completed:
    description: Each step uses a different separator and all pass
    commands:
      - rd run separator-syntax.runbook.md
    result: COMPLETE
---

# Separator Syntax

## 1. Period separator

- PASS CONTINUE

```bash
rd echo "period"
```

## 2: Colon separator

- PASS CONTINUE

```bash
rd echo "colon"
```

## 3) Paren separator

- PASS COMPLETE

```bash
rd echo "paren"
```
