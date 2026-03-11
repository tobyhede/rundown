---
name: for-break-retry
description: Substep BREAK + iteration RETRY — retry fires, then BREAK exits (non-accumulating)
scenarios:
  break-after-retry:
    commands:
      - rd run --prompted for-break-retry.runbook.md
      # Attempt 1: sub1 FAIL (DEFER), sub2 FAIL (BREAK) → retry fires
      - rd fail
      - rd fail
      # Attempt 2 (retry): sub1 FAIL, sub2 FAIL (BREAK) → retries exhausted, BREAK exits
      - rd fail
      - rd fail
      # BREAK is non-accumulating → iterationResults=[] → vacuous pass → CONTINUE → step 2
      - rd pass
    result: COMPLETE
---
# BREAK + Iteration RETRY

Substep BREAK respects iteration-level retry. After retries exhausted, BREAK exits the loop.

## 1. Process items
- FOR i IN 1 TO 3
  - FAIL ANY RETRY 1 BREAK
- PASS ALL CONTINUE
- FAIL ANY STOP

### 1.1 First check
- PASS DEFER
- FAIL DEFER

Check item.

### 1.2 Second check
- PASS DEFER
- FAIL BREAK

Validate item.

## 2. Done
- PASS COMPLETE

All items processed.
