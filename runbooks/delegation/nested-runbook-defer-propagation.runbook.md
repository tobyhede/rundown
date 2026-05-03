---
name: nested-runbook-defer-propagation
description: 3-level DEFER propagation — root aggregates child aggregates grandchild
tags:
  - delegation
  - defer

scenarios:
  chain-completes:
    description: Root delegates to child which composes the grandchild via rd run; DEFER aggregation fires at every level; final terminal is COMPLETE at root
    commands:
      - rd run nested-runbook-defer-propagation.runbook.md
      - rd delegate
      - rd claim ${TOKEN}
    expect:
      result: COMPLETE
      steps:
        # Child aggregation (grandchild runs in a separate rd run subprocess
        # fired from inside child substep 1.1's body; its events do not
        # surface through the active scenario event stream)
        - runbook: nested-runbook-defer-propagation-child.runbook.md
          from: "1.1"
          action: DEFER
          result: PASS
        - runbook: nested-runbook-defer-propagation-child.runbook.md
          from: "1.2"
          action: COMPLETE
          result: PASS
          aggregated: true
        # Root aggregation (after root resumes with 1.2 local)
        - runbook: /nested-runbook-defer-propagation.runbook.md
          from: "1.1"
          action: DEFER
          result: PASS
        - runbook: /nested-runbook-defer-propagation.runbook.md
          from: "1.2"
          action: COMPLETE
          result: PASS
          aggregated: true
---

# Root DEFER Propagation (3-Level Chain)

Root of a 3-level DEFER propagation chain. Two DEFER substeps: 1.1
delegates to the child runbook (which in turn composes the grandchild
via `rd run`), 1.2 runs locally. Each level's aggregated COMPLETE
feeds the next level up's DEFER.

## 1. Root work

- PASS ALL COMPLETE
- FAIL ANY STOP

### 1.1 Delegated child task

Delegated to the child runbook.

- nested-runbook-defer-propagation-child.runbook.md

### 1.2 Local root task

```bash
rd echo "root local"
```
