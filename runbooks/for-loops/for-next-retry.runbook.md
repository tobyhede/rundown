---
name: for-next-retry
description: Substep NEXT + iteration RETRY — retry fires, then NEXT loops back
scenarios:
  next-after-retry:
    commands:
      - rd run --prompted for-next-retry.runbook.md
      # Iter 1 attempt 1: FAIL → retry fires
      - rd fail --token ${TOKEN} --step 1.1 --index 1
      # Iter 1 attempt 2: FAIL → retries exhausted, NEXT loops back
      - rd fail --token ${TOKEN} --step 1.1 --index 2
      # Iter 2: PASS → DEFER accumulates
      - rd pass --token ${TOKEN} --step 1.1 --index 3
      # Iter 3 (last): PASS → aggregation
      - rd pass --token ${TOKEN} --step 2
    result: COMPLETE
---
# NEXT + Iteration RETRY

Substep NEXT respects iteration-level retry. After retries exhausted, NEXT skips to next iteration.

## 1. Process items
- FOR i IN 1 TO 3
  - PASS ALL CONTINUE
  - FAIL ANY RETRY 1 DEFER
- PASS ALL CONTINUE
- FAIL ANY STOP

### 1.1 Check
- PASS DEFER
- FAIL NEXT

Check item.

## 2. Done
- PASS COMPLETE

All items processed.
