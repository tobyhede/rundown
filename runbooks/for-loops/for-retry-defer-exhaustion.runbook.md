---
name: for-retry-defer-exhaustion
description: Iteration RETRY exhaustion DEFERs a FAIL into parent FAIL ANY STOP
tags:
  - for-loops
  - retry
  - defer

scenarios:
  iter2-exhausts:
    description: Iter 1 passes on first attempt; iter 2 fails three times (initial + 2 retries) and exhaustion DEFERs a FAIL which trips FAIL ANY STOP
    commands:
      - rd run --prompted for-retry-defer-exhaustion.runbook.md
      # Iter 1 attempt 1: PASS -> DEFER accumulates PASS
      - rd pass
      # Iter 2 attempt 1: FAIL -> RETRY 2 consumes first retry
      - rd fail
      # Iter 2 attempt 2 (retry 1/2): FAIL -> RETRY 2 consumes second retry
      - rd fail
      # Iter 2 attempt 3 (retry 2/2): FAIL -> retry exhausted, exhaustion DEFER fires
      - rd fail
    expect:
      result: STOP
      steps:
        - from: "1.1.1"
          action: DEFER
          result: PASS
        - from: "1.2.1"
          action: RETRY
          result: FAIL
        - from: "1.2.1"
          action: RETRY
          result: FAIL
        - from: "1.2.1"
          action: STOP
          result: FAIL
          aggregated: true
---

# FOR RETRY Exhaustion DEFERs to Parent

Iteration-level `RETRY 2 DEFER` means: on FAIL, retry up to twice; on the
third FAIL, DEFER a FAIL result into parent aggregation. The parent's
`FAIL ANY STOP` must then fire because at least one DEFERred result was FAIL.

## 1. Process items

- FOR item IN 1 TO 2
  - PASS DEFER
  - FAIL RETRY 2 DEFER
- PASS ALL COMPLETE
- FAIL ANY STOP

### 1.1 Check {{item}}

Check item.
