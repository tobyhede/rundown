---
name: Code Review
description: A standardized process for code reviews with automated checks and human verification.
tags:
  - featured
scenarios:
  approved:
    description: All checks pass and reviewer approves immediately
    commands:
      - rd run --prompted code-review.runbook.md
      - rd pass
      - rd pass
      - rd pass
      - rd pass
    result: COMPLETE
  changes-requested:
    description: Reviewer requests changes, requiring a retry loop
    commands:
      - rd run --prompted code-review.runbook.md
      - rd pass
      - rd pass
      - rd fail
      - rd pass
      - rd pass
    result: COMPLETE
  automated-failure:
    description: Automated checks fail, stopping the process
    commands:
      - rd run --prompted code-review.runbook.md
      - rd fail
    result: STOP
---

# Code Review Process

Standard procedure for reviewing code changes before merging.

## 1. Automated Checks

- PASS: CONTINUE
- FAIL: STOP "Automated checks failed. Please fix before requesting review."

Run the automated linting and testing suite.

```bash
rd echo "Running lint..."
rd echo "Running tests..."
rd echo "Checks passed" --result pass
```

## 2. Self Review

- YES: CONTINUE
- NO: STOP "Self review failed."

Perform a self-review of your changes. Check for:
- [ ] Code style consistency
- [ ] No debug prints left
- [ ] Documentation updated

## 3. Peer Review

- PASS: CONTINUE
- FAIL: RETRY 3 GOTO 3

Request a peer review.

Wait for approval. If changes are requested, address them and retry this step.

```bash
rd echo "Waiting for reviewer..."
rd echo "Approval received?" --result pass
```

## 4. Merge

- PASS: COMPLETE "Code merged successfully."

Merge the changes into the main branch.

```bash
rd echo "Merging branch..." --result pass
```
