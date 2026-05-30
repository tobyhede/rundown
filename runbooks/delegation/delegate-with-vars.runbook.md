---
name: delegate-with-vars
description: Delegation with variables passed to child runbook
tags:
  - delegation
scenarios:
  completed:
    description: Delegate with --input, child echoes the variable
    commands:
      - rd run delegate-with-vars.runbook.md
      - rd claim ${TOKEN} --input environment=staging
    result: COMPLETE
---

# Delegate With Vars

Delegate a substep to a child runbook, passing variables via claim `--input`.

## 1. Delegated work

- PASS ALL COMPLETE
- FAIL ANY STOP

### 1.1 Child task

- DELEGATE
- delegate-with-vars-child.runbook.md
