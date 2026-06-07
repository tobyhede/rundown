---
name: goto-reopen-nondelegated
description: Backward GOTO re-opens a resolved non-delegated substep; it re-executes
tags:
  - goto
  - substeps
scenarios:
  reopen-and-complete:
    commands:
      - rd run --prompted goto-reopen-nondelegated.runbook.md
      - rd pass
      - rd fail
      - rd pass
      - rd pass
      - rd pass
    result: COMPLETE
---

# GOTO Re-open

Backward GOTO re-opens a substep that already carried a result.

## 1. Work

### 1.1 First

- PASS CONTINUE
- FAIL STOP

Do first.

### 1.2 Second

- PASS CONTINUE
- FAIL GOTO 1.1

Do second.

## 2. Done

- PASS COMPLETE

All done.
