---
name: for-retry-reopen-nondelegated
description: RETRY re-opens resolved non-delegated FOR substeps before completing
tags:
  - for
  - retry
  - substeps
scenarios:
  retry-reopens-and-completes:
    commands:
      - rd run --prompted for-retry-reopen-nondelegated.runbook.md
      - rd pass
      - rd fail
      - rd pass
    result: COMPLETE
---

# FOR RETRY Re-open

Parent RETRY re-opens non-delegated substeps in the active FOR frame.

## 1. Process item

- FOR item IN 1 TO 1
  - PASS ALL CONTINUE
  - FAIL ANY RETRY 1 STOP
- PASS ALL CONTINUE
- FAIL ANY STOP

### 1.1 First check

- PASS DEFER
- FAIL DEFER

Check first.

### 1.2 Second check

- PASS DEFER
- FAIL BREAK

Check second.

## 2. Done

- PASS COMPLETE

All done.
