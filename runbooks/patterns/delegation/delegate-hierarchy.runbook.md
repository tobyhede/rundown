---
name: delegate-hierarchy
description: Sequential multi-delegation with two substeps
tags:
  - delegation

scenarios:
  all-pass:
    description: Both substeps delegated and claimed successfully
    commands:
      - rd run delegate-hierarchy.runbook.md
      - rd delegate delegation-child-pass.runbook.md --step 1.1
      - rd claim ${TOKEN}
      - rd delegate delegation-child-pass.runbook.md --step 1.2
      - rd claim ${TOKEN_2}
    result: COMPLETE
---

# Delegation Hierarchy

Sequential multi-delegation — two substeps each delegated and claimed independently.

## 1. Multi-delegation

- PASS ALL: COMPLETE
- FAIL ANY: STOP

### 1.1 First child task

Delegated to a child runbook via `rd delegate`.

### 1.2 Second child task

Delegated to a child runbook via `rd delegate`.
