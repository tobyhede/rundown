---
name: goto-step-backward
description: Jump backward from step 2 to step 1 on failure
tags:
  - goto

scenarios:
  backward-jump:
    description: Pass step 1, fail step 2 (GOTO 1), pass step 1 again, pass step 2
    commands:
      - rd run --prompted goto-step-backward.runbook.md
      - rd pass
      - rd fail
      - rd pass
      - rd pass
    result: COMPLETE
---

# GOTO Step Backward

Fail step 2 to jump backward to step 1, then succeed on the second pass.

## 1. Setup
- PASS: CONTINUE
- FAIL: STOP

```bash
rd echo "setup"
```

## 2. Check
- PASS: COMPLETE
- FAIL: GOTO 1

```bash
rd echo "check"
```
