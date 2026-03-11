---
name: goto-step
description: Jump from step 1 to step 3, skipping step 2
tags:
  - goto

scenarios:
  completed:
    description: Pass step 1 (GOTO 3), pass step 3
    commands:
      - rd run --prompted goto-step.runbook.md
      - rd pass
      - rd pass
    result: COMPLETE
---

# GOTO Step

Jump from step 1 to step 3, skipping step 2.

## 1. Step Jump

- PASS GOTO 3
- FAIL STOP

```bash
rd echo "jump start"
```

## 2. Skipped Step

- PASS CONTINUE
- FAIL STOP

This step should be skipped.

```bash
rd echo --result fail
```

## 3. Jump Target

- PASS COMPLETE

Target of step jump.

```bash
rd echo "jump landed"
```
