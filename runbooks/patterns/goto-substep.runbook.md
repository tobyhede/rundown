---
name: goto-substep
description: Demonstrates GOTO N.M - jumping to a specific substep

scenarios:
  skip-substep:
    description: Setup step passes and jumps to substep 1.3, skipping 1.2
    commands:
      - rd run --prompted goto-substep.runbook.md
      - rd pass
      - rd pass
    result: COMPLETE
  setup-fails:
    description: Setup step fails and stops execution
    commands:
      - rd run --prompted goto-substep.runbook.md
      - rd fail
    result: STOPPED
---

# GOTO Substep
Demonstrates GOTO N.M - jumping to a specific substep.

## 1. Parent step

### 1.1 Setup
- PASS: GOTO 1.3
- FAIL: STOP

```bash
rd echo --result pass
```


### 1.2 Skipped


### 1.3 GOTO Target

Reached via GOTO from 1.1.

```bash
rd echo --result pass
```
