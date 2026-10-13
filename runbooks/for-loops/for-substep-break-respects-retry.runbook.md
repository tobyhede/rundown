---
name: for-substep-break-respects-retry
description: Substep BREAK respects iteration-level retry before exiting (non-accumulating)
scenarios:
  break-respects-retry:
    commands:
      - rd run --prompted for-substep-break-respects-retry.runbook.md
      # Attempt 1: sub1 FAIL (DEFER), sub2 FAIL (BREAK) → retry fires
      - rd fail --token ${TOKEN} --step 1.1 --index 1
      - rd fail --token ${TOKEN} --step 1.2 --index 1
      # Attempt 2 (retry 1): same → retry fires again
      - rd fail --token ${TOKEN} --step 1.1 --index 1
      - rd fail --token ${TOKEN} --step 1.2 --index 1
      # Attempt 3 (retry 2): retries exhausted → BREAK exits loop
      - rd fail --token ${TOKEN} --step 1.1 --index 1
      - rd fail --token ${TOKEN} --step 1.2 --index 1
      # BREAK is non-accumulating → iterationResults=[] → vacuous pass → CONTINUE → step 2
      - rd pass --token ${TOKEN} --step 2
    result: COMPLETE
---
# Substep BREAK Respects Iteration Retry

## 1. Process items
- FOR i IN 1 TO 3
  - PASS ALL CONTINUE
  - FAIL ANY RETRY 2 BREAK
- PASS ALL CONTINUE
- FAIL ANY STOP

### 1.1 First check
- PASS DEFER
- FAIL DEFER

Do the first check.

### 1.2 Second check
- PASS DEFER
- FAIL BREAK

Do the second check.

## 2. Done
- PASS COMPLETE

All items processed.
