---
name: for-next-no-accumulation
description: NEXT never accumulates — iterationResults stays empty
scenarios:
  next-no-accumulation:
    commands:
      - rd run --prompted for-next-no-accumulation.runbook.md
      # Iter 1: PASS → NEXT (no accumulation)
      - rd pass
      # Iter 2: FAIL → NEXT (no accumulation)
      - rd fail
      # Iter 3 (last): PASS → NEXT → exit to aggregation
      - rd pass
      # Step 2: PASS → COMPLETE
      - rd pass
    result: COMPLETE
---
# NEXT Non-Accumulation

NEXT skips accumulation — iterationResults stays empty regardless of substep results.
All NEXT iterations produce a vacuous pass at parent aggregation.

## 1. Process items
- FOR i IN 1 TO 3
- PASS ALL: CONTINUE
- FAIL ANY: STOP

### 1.1 Check
- PASS: NEXT
- FAIL: NEXT

Check item.

## 2. Done
- PASS: COMPLETE

All items processed.
