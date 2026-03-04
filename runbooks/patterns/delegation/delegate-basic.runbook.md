---
name: delegate-basic
description: Basic delegation pattern — substep delegated to child runbook
tags:
  - delegation

scenarios:
  completed:
    description: Delegate substep to child, child auto-completes
    commands:
      - rd run delegate-basic.runbook.md
      - rd delegate delegation-child-pass.runbook.md --step 1.1
      - rd claim ${TOKEN}
    result: COMPLETE
---

# Basic Delegation

Delegate a substep to a child runbook that auto-completes.

## 1. Delegated work

- PASS ALL COMPLETE
- FAIL ANY STOP

### 1.1 Child task

Delegated to a child runbook via `rd delegate`.
