---
name: inline-goto-reentry
description: A GOTO back onto a step with an inline substep reserves and launches a fresh child; the earlier child's result is never collected
tags:
  - composition
  - inline
  - goto

scenarios:
  fail-goto-relaunches:
    description: The first child completes and the parent reaches Review; FAIL GOTO 1 re-enters the step, which launches a fresh child rather than Collecting the finished one again, so --step Check is still the child's step
    commands:
      - rd run inline-goto-reentry.runbook.md
      - rd pass --token ${TOKEN} --step Check
      - rd fail --token ${TOKEN} --step 2
      - rd pass --token ${TOKEN} --step Check
      - rd pass --token ${TOKEN} --step 2
    result: COMPLETE

  operator-goto-relaunches:
    description: An operator goto back to step 1 from Review launches a fresh child the same way
    commands:
      - rd run inline-goto-reentry.runbook.md
      - rd pass --token ${TOKEN} --step Check
      - rd goto --token ${TOKEN} 1
      - rd pass --token ${TOKEN} --step Check
      - rd pass --token ${TOKEN} --step 2
    result: COMPLETE
---

# Inline GOTO Re-entry

## 1. Compose

- PASS ALL CONTINUE
- FAIL ANY STOP

- inline-child-manual.runbook.md

## 2. Review

- PASS COMPLETE
- FAIL GOTO 1

Review the child's work.
