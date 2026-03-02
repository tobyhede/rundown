---
name: goto-cross-step-substep
description: Jump from a substep in one parent to a substep in another parent
tags:
  - goto

scenarios:
  completed:
    description: Pass substep 1.1 (GOTO 2.2), pass substep 2.2
    commands:
      - rd run --prompted goto-cross-step-substep.runbook.md
      - rd pass
      - rd pass
    result: COMPLETE
---

# GOTO Cross-Step Substep

Jump from substep 1.1 to substep 2.2 in a different parent step.

## 1. Origin

### 1.1 Start
- PASS: GOTO 2.2
- FAIL: STOP

```bash
rd echo "start"
```

## 2. Destination

### 2.1 Skipped
- PASS: CONTINUE

```bash
rd echo --result fail
```

### 2.2 Target
- PASS: COMPLETE

```bash
rd echo "landed"
```
