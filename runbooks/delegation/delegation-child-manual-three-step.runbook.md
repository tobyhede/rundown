---
name: delegation-child-manual-three-step
description: Manual three-step child runbook for claim-id targeting scenarios
tags:
  - delegation

scenarios:
  all-pass:
    description: Manual child completes after three explicit passes
    commands:
      - rd run --prompted delegation-child-manual-three-step.runbook.md
      - rd pass
      - rd pass
      - rd pass
    result: COMPLETE
---

# Delegation Child Manual Three Step

Manual child runbook used by claim-id targeting scenarios.

## 1. First child step

- PASS CONTINUE
- FAIL STOP

First child step.

## 2. Second child step

- PASS CONTINUE
- FAIL STOP

Second child step.

## 3. Third child step

- PASS COMPLETE
- FAIL STOP

Third child step.
