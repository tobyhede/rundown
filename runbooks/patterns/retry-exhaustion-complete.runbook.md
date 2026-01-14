---
name: retry-exhaustion-complete
description: Demonstrates RETRY with COMPLETE on exhaustion

scenarios:
  success-after-retry:
    description: Step 2 fails twice then passes on third try
    commands:
      - rd run --prompted retry-exhaustion-complete.runbook.md
      - rd pass
      - rd fail
      - rd fail
      - rd pass
      - rd pass
    result: COMPLETE
  exhaustion-complete:
    description: Step 2 exhausts retries, completes via fallback
    commands:
      - rd run --prompted retry-exhaustion-complete.runbook.md
      - rd pass
      - rd fail
      - rd fail
      - rd fail
      - rd fail
    result: COMPLETE
---

# Retry Exhaustion COMPLETE

Demonstrates RETRY with COMPLETE on exhaustion.

## 1. Setup
- PASS: CONTINUE
- FAIL: STOP

Prepare the environment.

```bash
rd echo "setup environment"
```


## 2. Execute
- PASS: CONTINUE
- FAIL: RETRY 3 COMPLETE "Max retries reached, completing anyway"

Retry up to 3 times, then complete successfully.

```bash
rd echo "retry operation" --result fail --result fail --result pass
```


## 3. Cleanup
- PASS: COMPLETE
- FAIL: STOP

Final cleanup.

```bash
rd echo "cleanup resources"
```

