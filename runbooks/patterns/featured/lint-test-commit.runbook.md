---
name: Lint-Test-Commit
description: Lint Test and Fix in a loop until `PASS`, then commit.
tags:
  - featured
scenarios:
  completed:
    description: Lint, Test, & Commit
    commands:
      - rd run --prompted lint-test-commit.runbook.md
      - rd pass  # 1 Run Lint Checks - CONTINUE
      - rd pass  # 2 Run Tests - CONTINUE
      - rd pass  # 3 Commit - CONTINUE
    result: COMPLETE
  via-fix-test:
    description: Lint, Test failure with Fix, then Commit
    commands:
      - rd run --prompted lint-test-commit.runbook.md
      - rd pass  # 1 Run Lint Checks - CONTINUE
      - rd fail  # 2 Run Tests - GOTO FixTest
      - rd pass  # FixTest - GOTO 2
      - rd pass  # 2 Run Tests - CONTINUE
      - rd pass  # 3 Commit Changes - COMPLETE
    result: COMPLETE
  stopped:
    description:  Lint failure with Fix, Test failure and fix until STOP
    commands:
      - rd run --prompted lint-test-commit.runbook.md
      - rd fail  # 1 Run Lint Checks - GOTO FixLint
      - rd pass  # FixLint - GOTO 1
      - rd pass  # 1 Run Lint Checks - CONTINUE
      - rd fail  # 2 Run Tests - GOTO FixTest
      - rd pass  # FixTest - GOTO 2
      - rd fail  # 2 Run Tests - GOTO FixTest
      - rd fail  # FixTest - STOP
    result: STOP
---

# Lint, Test & Commit

Lint, Test and Fix in a loop until `PASS`, then commit.


## 1. Run Lint Checks
- FAIL: GOTO FixLint

Run the test suite to verify the implementation.

```bash
rd echo npm lint
```


## 2. Run Tests
- FAIL: GOTO FixTest

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


## FixLint. Fix lint issues.

- YES: GOTO 1
- NO: STOP "Unable to fix lint issues"

Follow the project guidelines and address all lint issues.


## FixTest. Fix all failing tests.

- YES: GOTO 2
- NO: STOP "Unable to fix failing test/s"

Fix all failing tests



