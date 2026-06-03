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
      - rd claim ${TOKEN}
    result: COMPLETE
    expect:
      steps:
        - runbook: delegation-child-pass.runbook.md
          from: "1"
          action: COMPLETE
          result: PASS
        - from: "1.1"
          action: COMPLETE
          result: PASS
---

# Basic Delegation

Delegate a substep to a child runbook that auto-completes.

## 1. Delegated work

- DELEGATE
- PASS ALL COMPLETE
- FAIL ANY STOP

### 1.1 Child task

- DELEGATE
- delegation-child-pass.runbook.md
