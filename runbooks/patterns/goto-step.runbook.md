---
name: goto-step
description: Demonstrates GOTO N - jumping to a specific step

scenarios:
  success:
    description: Jump from step 1 to step 3, complete workflow
    commands:
      - rd run --prompted goto-step.runbook.md
      - rd pass
      - rd pass
    result: COMPLETE
---

# GOTO Step
Demonstrates GOTO N - jumping to a specific step number.

## 1. Setup
- PASS: GOTO 3
- FAIL: STOP

```bash
rd echo --result pass
```


## 2. Skip
- PASS: CONTINUE
- FAIL: STOP

This step is skipped via GOTO.

```bash
rd echo --result fail
```


## 3. Jump target
- PASS: COMPLETE
- FAIL: STOP

Reached via GOTO from step 1.

```bash
rd echo --result pass
```

