---
name: nested-runbook-defer-propagation
description: 3-level DEFER propagation — root aggregates child aggregates grandchild
tags:
  - delegation
  - defer

scenarios:
  chain-completes:
    description: Root delegates to child which delegates to grandchild; DEFER aggregation fires at every level; final terminal is COMPLETE at root
    commands:
      - rd run nested-runbook-defer-propagation.runbook.md
      - rd delegate
      - rd claim ${TOKEN}
      - rd delegate
      - rd claim ${TOKEN_2}
    expect:
      result: COMPLETE
      steps:
        # Grandchild aggregation (emitted first, inside child's 1.1 claim)
        - runbook: nested-runbook-defer-propagation-grandchild.runbook.md
          from: "1.1"
          action: DEFER
          result: PASS
        - runbook: nested-runbook-defer-propagation-grandchild.runbook.md
          from: "1.2"
          action: COMPLETE
          result: PASS
          aggregated: true
        # Child aggregation (after child resumes with 1.2 local)
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
delegates to the child runbook (which in turn delegates to the
grandchild), 1.2 runs locally. Each level's aggregated COMPLETE feeds
the next level up's DEFER.

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
