---
name: goto-named-substep
description: Jump to a named substep using GOTO
tags:
  - goto

scenarios:
  completed:
    description: Pass substep 1.1 (GOTO 1.Cleanup), pass 1.Cleanup
    commands:
      - rd run --prompted goto-named-substep.runbook.md
      - rd pass
      - rd pass
    result: COMPLETE
---

# GOTO Named Substep

Jump from substep 1.1 to named substep 1.Cleanup.

## 1. Named Substep Jump

### 1.1 Start

- PASS: GOTO 1.Cleanup
- FAIL: STOP

```bash
rd echo "named start"
```

### 1.Cleanup

- PASS: COMPLETE

```bash
rd echo "cleanup"
```
