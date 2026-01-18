---
name: Dev/Test with Retry
description: Development workflow with automatic retries and failure recovery.
tags:
  - featured
scenarios:
  first-pass:
    description: Tests pass on the first attempt
    commands:
      - rd run --prompted dev-test-retry.runbook.md
      - rd pass
      - rd pass
    result: COMPLETE
  flaky-test-retry:
    description: Tests fail initially, but pass after recovery and retry
    commands:
      - rd run --prompted dev-test-retry.runbook.md
      - rd fail
      - rd pass
      - rd pass
      - rd pass
      - rd pass
      - rd pass
    result: COMPLETE
  impossible-fix:
    description: Tests continue to fail despite recovery attempts
    commands:
      - rd run --prompted dev-test-retry.runbook.md
      - rd fail
      - rd pass
      - rd fail
    result: STOP
---

# Dev/Test Loop

A workflow for implementing features and ensuring tests pass with recovery.

## 1. Run Tests

- PASS: GOTO 3
- FAIL: CONTINUE

Run the test suite to verify the implementation.

```bash
rd echo "Running tests..." --result pass
```

## 2. Recovery and Fix

- PASS: RETRY 2 GOTO 1
- FAIL: STOP "Unable to fix tests after multiple attempts."

Attempt to fix the environment or the code.

```bash
rd echo "Attempting automated fix..." --result pass
```

## 3. Commit Changes

- PASS: COMPLETE "Feature implemented and verified."

Commit the changes to the repository.

```bash
rd echo "git commit -m 'feat: implement new logic'" --result pass
```