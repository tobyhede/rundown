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
      - rd claim ${TOKEN}
      - rd claim ${TOKEN_2}
      - rd collect
    result: COMPLETE
---

# Delegation Hierarchy

Sequential multi-delegation — two substeps each delegated and claimed independently.

## 1. Multi-delegation

- PASS ALL COMPLETE
- FAIL ANY STOP

### 1.1 First child task

- DELEGATE
- delegation-child-pass.runbook.md

### 1.2 Second child task

- DELEGATE
- delegation-child-pass.runbook.md
