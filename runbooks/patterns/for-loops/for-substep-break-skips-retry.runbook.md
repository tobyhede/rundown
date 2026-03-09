---
name: for-substep-break-skips-retry
description: Substep BREAK bypasses iteration-level retry
scenarios:
  break-skips-retry:
    commands:
      - rd run --prompted for-substep-break-skips-retry.runbook.md
      - rd fail
      - rd fail
    result: STOP
---
# Substep BREAK Skips Iteration Retry

## 1. Process items
- FOR i IN 1 TO 3
  - FAIL ANY: RETRY 2 BREAK
- PASS ALL: CONTINUE
- FAIL ANY: STOP

### 1.1 First check
- PASS: DEFER
- FAIL: DEFER

Do the first check.

### 1.2 Second check
- PASS: DEFER
- FAIL: BREAK

Do the second check.

## 2. Done
- PASS: COMPLETE

All items processed.
