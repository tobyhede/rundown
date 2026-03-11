---
name: for-break-no-retry
description: Substep BREAK with no retry configured — BREAK exits immediately (non-accumulating)
scenarios:
  break-immediate:
    commands:
      - rd run --prompted for-break-no-retry.runbook.md
      # Iter 1: sub1 FAIL (DEFER feeds 'fail'), sub2 FAIL (BREAK exits loop)
      - rd fail
      - rd fail
      # BREAK is non-accumulating → iterationResults=[] → vacuous pass → CONTINUE → step 2
      - rd pass
    result: COMPLETE
---
# BREAK Without Retry

BREAK exits the loop immediately when no iteration-level retry is configured.
BREAK is non-accumulating — the current iteration's result is not added to parent aggregation.

## 1. Process items
- FOR i IN 1 TO 3
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
