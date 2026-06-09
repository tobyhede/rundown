---
name: delegate-open-children-guard
description: A bare rd pass/fail is refused while a claimed delegated child is open
tags:
  - delegation
  - claim-id

scenarios:
  bare-pass-refused-while-child-open:
    description: Bare rd pass is refused with OPEN_DELEGATED_CHILDREN while a claimed child is open
    commands:
      - true delegation-child-manual-one-step.runbook.md
      - rd run --prompted delegate-open-children-guard.runbook.md
      - rd claim ${TOKEN}
      - "! rd pass"
    expect:
      errors:
        - code: OPEN_DELEGATED_CHILDREN
          command: pass
  bare-fail-refused-while-child-open:
    description: Bare rd fail is refused with OPEN_DELEGATED_CHILDREN while a claimed child is open
    commands:
      - true delegation-child-manual-one-step.runbook.md
      - rd run --prompted delegate-open-children-guard.runbook.md
      - rd claim ${TOKEN}
      - "! rd fail"
    expect:
      errors:
        - code: OPEN_DELEGATED_CHILDREN
          command: fail
---

# Open Delegated Children Guard

A bare `rd pass` / `rd fail` must not advance the parent while a claimed
delegated child is still open. Core refuses the unsafe parent transition with
`OPEN_DELEGATED_CHILDREN`; the agent must resolve the child with `--claim-id`
(or collect the delegated children) before advancing the parent.

## 1. Delegated child

- DELEGATE
- PASS ALL COMPLETE
- FAIL ANY STOP

### 1.1 Child task

- delegation-child-manual-one-step.runbook.md
