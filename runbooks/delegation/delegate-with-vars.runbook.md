---
name: delegate-with-vars
description: Delegation with variables passed to child runbook
tags:
  - delegation
scenarios:
  completed:
    description: Delegate with --var, child echoes the variable
    commands:
      - rd run delegate-with-vars.runbook.md
      - rd delegate delegate-with-vars-child.runbook.md --step 1.1 --var environment=staging
      - rd claim ${TOKEN}
    result: COMPLETE
---

# Delegate With Vars

Delegate a substep to a child runbook, passing variables via `--var`.

## 1. Delegated work

- PASS ALL: COMPLETE
- FAIL ANY: STOP

### 1.1 Child task

Delegated to a child runbook with variables.
