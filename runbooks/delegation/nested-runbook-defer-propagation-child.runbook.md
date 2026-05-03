---
name: nested-runbook-defer-propagation-child
description: Child with two DEFER substeps under PASS ALL; 1.1 composes grandchild inline, 1.2 runs locally
tags:
  - delegation
  - defer

scenarios:
  auto-pass:
    description: Composed grandchild completes; local substep passes; aggregated COMPLETE
    commands:
      - rd run nested-runbook-defer-propagation-child.runbook.md
      - rd pass
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

# Child DEFER Aggregation (With Grandchild Composition)

Middle of a 3-level DEFER propagation chain. Substep 1.1 composes the
grandchild runbook inline; 1.2 runs locally. Both default to
DEFER under `PASS ALL COMPLETE`.

## 1. Child work

- PASS ALL COMPLETE
- FAIL ANY STOP

### 1.1 Composed grandchild task

- nested-runbook-defer-propagation-grandchild.runbook.md

### 1.2 Local child task

```bash
rd echo "child local"
```
