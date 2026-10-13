---
name: goto-step-backward
description: Jump backward from step 2 to step 1 on failure
tags:
  - goto

scenarios:
  backward-jump:
    description: Fail step 2, GOTO 1, pass both steps
    commands:
      - rd run --prompted goto-step-backward.runbook.md
      - rd pass --token ${TOKEN} --step 1
      - rd fail --token ${TOKEN} --step 2
      - rd pass --token ${TOKEN} --step 1
      - rd pass --token ${TOKEN} --step 2
    result: COMPLETE
---

# GOTO Step Backward

Fail step 2 to jump backward to step 1, then succeed on the second pass.

## 1. Setup

- PASS CONTINUE
- FAIL STOP

```bash
rd echo "setup"
```

## 2. Check

- PASS COMPLETE
- FAIL GOTO 1

```bash
rd echo "check"
```
