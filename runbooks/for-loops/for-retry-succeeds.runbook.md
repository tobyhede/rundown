---
name: for-retry-succeeds
description: RETRY succeeds on second attempt — no BREAK
scenarios:
  retry-succeeds:
    commands:
      - rd run --prompted for-retry-succeeds.runbook.md
      # Iter 1 attempt 1: sub1 FAIL (DEFER), sub2 FAIL (BREAK) → retry fires
      - rd fail
      - rd fail
      # Iter 1 attempt 2 (retry): sub1 PASS (DEFER), sub2 PASS (DEFER) → pass → DEFER accumulates
      - rd pass
      - rd pass
      # Iter 2: sub1 PASS, sub2 PASS → pass → DEFER accumulates
      - rd pass
      - rd pass
    result: COMPLETE
---
# RETRY Succeeds — No BREAK

Retry gives the iteration another chance. If substeps pass on retry, BREAK never fires.

## 1. Process items
- FOR i IN 1 TO 2
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
