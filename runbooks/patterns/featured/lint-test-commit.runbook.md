---
name: Lint, Test, & Commit
description: Lint, Test and Fix in a loop until `PASS`, then commit.
tags:
  - featured
scenarios:
  completed:
    description:
    commands:
      - rd run --prompted lint-test-commit.runbook.md
      - rd pass  # 1 Run Tests
      - rd pass  # 3 Commit Changes
    result: COMPLETE
  flaky-test-retry:
    description: Tests fail initially, but pass after recovery and retry
    skip: true  # TODO: Fix RETRY state tracking - completion not recorded after RETRY GOTO sequence
    commands:
      - rd run --prompted lint-test-commit.runbook.md
      - rd fail  # 1 Run Tests - CONTINUE
      - rd pass  # 2 Recovery and Fix - RETRY (1/2) GOTO 1
      - rd pass  # 1 Run Tests - GOTO 3
      - rd pass  # 3 Commit Changes - COMPLETE
    result: COMPLETE
  impossible-fix:
    description: Tests continue to fail despite recovery attempts
    skip: true  # TODO: Fix RETRY state tracking - completion not recorded after RETRY GOTO sequence
    commands:
      - rd run --prompted lint-test-commit.runbook.md
      - rd fail  # 1 Run Tests - CONTINUE
      - rd pass  # 2 Recovery and Fix - RETRY (1/2) GOTO 1
      - rd fail  # 1 Run Tests - CONTINUE
      - rd pass  # 2 Recovery and Fix - RETRY (2/2) GOTO 1
      - rd fail  # 1 Run Tests - CONTINUE
      - rd fail  # 2 Recovery and Fix - retries exhausted, STOP
    result: STOP
---

# Lint, Test & Commit

Lint, Test and Fix in a loop until `PASS`, then commit.


## 1. Run Lint Checks
- FAIL: GOTO FIX_LINT

Run the test suite to verify the implementation.

```bash
rd echo npm lint
```


## 2. Run Tests
- FAIL: GOTO FIX_TESTS

Run the test suite to verify the implementation.

```bash
rd echo npm test
```

## 3. Commit Changes
- PASS: COMPLETE

Commit the changes to the repository.

```bash
rd echo git commit -m 'feat: implement new logic'
```


## FIX_LINT. Fix lint issues.

- YES: GOTO 1
- NO: STOP "Unable to fix lint issues"

Follow the project guidelines and address all lint issues.


## FIX_TESTS. Fix all failing tests.

- YES: GOTO 2
- NO: STOP "Unable to fix lint issues"

Follow the project guidelines and address all lint issues.



