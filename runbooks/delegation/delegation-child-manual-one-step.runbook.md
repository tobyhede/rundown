---
name: delegation-child-manual-one-step
description: Manual one-step child runbook for delegation scenarios
tags:
  - delegation

scenarios:
  pass:
    description: Manual child completes after one explicit pass
    commands:
      - rd run --prompted delegation-child-manual-one-step.runbook.md
      - rd pass
    result: COMPLETE
---

# Delegation Child Manual One Step

Manual child runbook used by delegation scenario fixtures.

## 1. Child step

- PASS COMPLETE
- FAIL STOP

Child step.
