---
name: goto-substep
description: Jump from substep 1.1 to substep 1.3, skipping 1.2
tags:
  - goto

scenarios:
  completed:
    description: Pass substep 1.1 (GOTO 1.3), pass substep 1.3
    commands:
      - rd run --prompted goto-substep.runbook.md
      - rd pass
      - rd pass
    result: COMPLETE
---

# GOTO Substep

Jump from substep 1.1 to substep 1.3, skipping 1.2.

## 1. Substep Jump

### 1.1 Start

- PASS: GOTO 1.3
- FAIL: STOP

```bash
rd echo "substep start"
```

### 1.2 Skipped

- PASS: CONTINUE

```bash
rd echo --result fail
```

### 1.3 Target

- PASS: COMPLETE

```bash
rd echo "substep landed"
```
