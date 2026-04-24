---
name: defer-mixed-delegation-local
description: One step with a delegated substep and a local bash substep — both DEFER into shared aggregation
tags:
  - substeps
  - delegation
  - defer

scenarios:
  both-pass:
    description: Delegated substep passes via claim; local substep passes via bash exit 0; aggregated COMPLETE fires
    commands:
      - rd run defer-mixed-delegation-local.runbook.md
      - rd delegate
      - rd claim ${TOKEN}
    expect:
      result: COMPLETE
      steps:
        - from: "1.1"
          action: DEFER
          result: PASS
        - from: "1.2"
          action: COMPLETE
          result: PASS
          aggregated: true
---

# Mixed Delegation + Local DEFER

One step, two substeps. 1.1 is delegated to a child runbook; 1.2 executes
locally. Both default to DEFER under `PASS ALL COMPLETE`. Parent aggregation
must treat the two substep kinds identically.

## 1. Mixed work

- PASS ALL COMPLETE
- FAIL ANY STOP

### 1.1 Delegated task

Delegated to a child runbook.

- delegation-child-pass.runbook.md

### 1.2 Local task

```bash
rd echo "local work"
```
