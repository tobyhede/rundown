---
name: substep-goto
description: GOTO between substeps in the same parent step
tags:
  - substeps
  - goto

scenarios:
  completed:
    description: Pass substep 1.1 (GOTO 1.3), pass substep 1.3
    commands:
      - rd run --prompted substep-goto.runbook.md
      - rd pass
      - rd pass
    result: COMPLETE
---

# Substep GOTO

GOTO from substep 1.1 to substep 1.3, skipping 1.2.

## 1. Parent

### 1.1 Start

- PASS GOTO 1.3
- FAIL STOP

```bash
rd echo "start"
```

### 1.2 Skipped

- PASS CONTINUE

```bash
rd echo --result fail
```

### 1.3 Target

- PASS COMPLETE

```bash
rd echo "target"
```
