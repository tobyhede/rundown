---
name: goto-restart-dynamic
description: Demonstrates restarting the current dynamic step from the beginning using GOTO {N}

scenarios:
  iterate-then-stop:
    description: Setup and Execute pass, GOTO NEXT advances, then fail stops
    commands:
      - rd run --prompted goto-restart-dynamic.runbook.md
      - rd pass
      - rd pass
      - rd fail
    result: STOP
tags:
  - navigation
  - dynamic
---

# GOTO {N} - Restart Dynamic Instance

Demonstrates restarting the current dynamic step from the beginning.

## {N}. Process Item

### {N}.1 Setup
- PASS: CONTINUE

```bash
rd echo --result pass
```


### {N}.2 Execute
- PASS: GOTO NEXT
- FAIL: GOTO {N}

```bash
rd echo --result pass --result fail
```

