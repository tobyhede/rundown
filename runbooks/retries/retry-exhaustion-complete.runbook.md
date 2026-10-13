---
name: retry-exhaustion-complete
description: RETRY exhaustion with COMPLETE finishes the runbook
tags:
  - retries

scenarios:
  exhausted:
    description: Exhausts retry, runbook completes
    commands:
      - rd run --prompted retry-exhaustion-complete.runbook.md
      - rd fail --token ${TOKEN} --step 1
      - rd fail --token ${TOKEN} --step 1
      - rd fail --token ${TOKEN} --step 1
      - rd fail --token ${TOKEN} --step 1
    result: COMPLETE
  recovered:
    description: Passes on first attempt, continues to finish step
    commands:
      - rd run --prompted retry-exhaustion-complete.runbook.md
      - rd pass --token ${TOKEN} --step 1
      - rd pass --token ${TOKEN} --step 2
    result: COMPLETE
  auto-execution:
    description: Auto-execute fails four times, completes via exhaustion
    commands:
      - rd run retry-exhaustion-complete.runbook.md
    result: COMPLETE
---

# RETRY Exhaustion COMPLETE

Tests that RETRY exhaustion with COMPLETE finishes the runbook successfully.

## 1. Acceptable-failure step

- PASS CONTINUE
- FAIL RETRY 3 COMPLETE "Max retries reached, completing anyway"

Retries up to 3 times. If it still fails, it COMPLETES the runbook.

```bash
rd echo --result fail --result fail --result fail --result fail
```

## 2. Finish

- PASS COMPLETE

Final step reached when step 1 passes.

```bash
rd echo "finished normally"
```
