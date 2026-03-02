---
name: delegate-basic
description: Basic delegation pattern with prepare and execute steps
tags:
  - delegation

scenarios:
  completed:
    description: Pass both delegation steps
    commands:
      - rd run --prompted delegate-basic.runbook.md
      - rd pass
      - rd pass
    result: COMPLETE
---

# Basic Delegation

Basic delegation pattern with prepare and execute steps.

## 1. Prepare delegation
- PASS: CONTINUE
- FAIL: STOP

```bash
rd echo "prepare delegation"
```

## 2. Execute delegated work
- PASS: COMPLETE
- FAIL: STOP

```bash
rd echo "delegated work done"
```
