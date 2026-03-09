---
name: for-substep-break-skips-retry
description: Substep BREAK bypasses iteration-level retry
scenarios:
  break-skips-retry:
    commands:
      - rd run {{file}} --prompted -y --var items=a,b,c
      - rd fail
    result: STOP
---
# Substep BREAK Skips Iteration Retry

## 1. Process items
- FOR item IN {{ items }}
  - FAIL ANY: RETRY 2 BREAK
- PASS ALL: CONTINUE
- FAIL ANY: STOP

### 1.1 Check
- PASS: DEFER
- FAIL: BREAK

Check the item.

## 2. Done
- PASS: COMPLETE

All items processed.
