---
name: for-retry-defer
description: Normal DEFER + RETRY — retry fires, then DEFER accumulates
scenarios:
  retry-then-defer:
    commands:
      - rd run --prompted for-retry-defer.runbook.md
      # Iter 1 attempt 1: FAIL → retry fires
      - rd fail --token ${TOKEN} --step 1.1 --index 1
      # Iter 1 attempt 2 (retry): PASS → DEFER accumulates 'pass'
      - rd pass --token ${TOKEN} --step 1.1 --index 1
      # Iter 2: PASS → DEFER accumulates 'pass'
      - rd pass --token ${TOKEN} --step 2
    result: COMPLETE
---
# DEFER + Iteration RETRY

Normal DEFER flow with iteration-level retry. Retry re-runs the iteration, then DEFER accumulates.

## 1. Process items
- FOR i IN 1 TO 2
  - PASS ALL CONTINUE
  - FAIL ANY RETRY 1 DEFER
- PASS ALL CONTINUE
- FAIL ANY STOP

### 1.1 Check
- PASS DEFER
- FAIL DEFER

Check item.

## 2. Done
- PASS COMPLETE

All items processed.
