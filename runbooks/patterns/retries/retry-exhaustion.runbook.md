---
name: retry-exhaustion
description: Demonstrates various RETRY exhaustion behaviors (CONTINUE, STOP, GOTO, COMPLETE)
tags:
  - retries

scenarios:
  continue:
    description: Exhaustion triggers CONTINUE, proceeds to next step
    commands:
      - rd run --prompted retry-exhaustion.runbook.md
      - rd fail
      - rd fail
      - rd pass
    result: COMPLETE

  stop:
    description: Exhaustion triggers STOP (default or explicit), workflow halts
    commands:
      - rd run --step 2 retry-exhaustion.runbook.md
      - rd fail
      - rd fail
    result: STOP

  goto:
    description: Exhaustion triggers GOTO, jumps to recovery step
    commands:
      - rd run --step 3 retry-exhaustion.runbook.md
      - rd fail
      - rd fail
      - rd fail
      - rd pass
    result: COMPLETE

  complete:
    description: Exhaustion triggers COMPLETE, workflow finishes immediately
    commands:
      - rd run --step 5 retry-exhaustion.runbook.md
      - rd pass
      - rd fail
      - rd fail
      - rd fail
      - rd fail
    result: COMPLETE
---

# RETRY Exhaustion Patterns

Demonstrates different behaviors when a step exhausts its retry count.

## 1. Exhaustion CONTINUE
- PASS: COMPLETE
- FAIL: RETRY 1 CONTINUE

Fails initially, retries once. If it fails again, it CONTINUES to the next step.
This allows "best effort" steps.

```bash
rd echo --result fail --result fail
```

## 2. Exhaustion STOP
- PASS: COMPLETE
- FAIL: RETRY 1 STOP

Fails initially, retries once. If it fails again, it STOPS the workflow.
This is for critical steps that must succeed eventually.

```bash
rd echo --result fail --result fail
```

## 3. Exhaustion GOTO
- PASS: COMPLETE
- FAIL: RETRY 2 GOTO Recovery

Fails up to 2 times. If it exhausts, it jumps to the Recovery step.

```bash
rd echo --result fail --result fail --result fail
```

## 4. Recovery
- PASS: COMPLETE

Recovery step reached from Step 3 exhaustion.

```bash
rd echo "recovered"
```

## 5. Exhaustion COMPLETE
- PASS: CONTINUE
- FAIL: RETRY 3 COMPLETE "Max retries reached, completing anyway"

Retries up to 3 times. If it still fails, it COMPLETES the workflow (success state).
Useful if the failure is acceptable as a final state.

```bash
rd echo "retry operation" --result fail --result fail --result pass
```
