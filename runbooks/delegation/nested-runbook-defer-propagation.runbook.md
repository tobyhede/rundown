---
name: nested-runbook-defer-propagation
description: DEFER propagation with a delegated child and local substep
tags:
  - delegation
  - defer

scenarios:
  chain-completes:
    description: Root delegates to child and aggregates it with local work
    commands:
      - rd run nested-runbook-defer-propagation.runbook.md
      - rd claim ${TOKEN}
      - rd collect --run ${RUN_ID}
    expect:
      result: COMPLETE
      steps:
        - runbook: nested-runbook-defer-propagation.runbook.md
          from: "1.1"
          action: DEFER
          result: PASS
        - runbook: nested-runbook-defer-propagation.runbook.md
          from: "1.2"
          action: COMPLETE
          result: PASS
          aggregated: true
---

# Root DEFER Propagation (3-Level Chain)

Root with two DEFER substeps: 1.1 delegates to a child runbook, 1.2 runs
locally. Aggregated COMPLETE fires after both substeps pass.

## 1. Root work

- PASS ALL COMPLETE
- FAIL ANY STOP

### 1.1 Delegated child task

- DELEGATE
- delegation-child-pass.runbook.md

### 1.2 Local root task

```bash
rd echo "root local"
```
