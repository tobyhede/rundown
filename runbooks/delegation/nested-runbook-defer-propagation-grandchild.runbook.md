---
name: nested-runbook-defer-propagation-grandchild
description: Grandchild with two DEFER substeps under PASS ALL — aggregates to COMPLETE
tags:
  - delegation
  - defer

scenarios:
  auto-pass:
    description: Both DEFER substeps pass via bash exit 0; aggregated COMPLETE
    commands:
      - rd run nested-runbook-defer-propagation-grandchild.runbook.md
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

# Grandchild DEFER Aggregation

Leaf of a 3-level DEFER propagation chain.

## 1. Grandchild work

- PASS ALL COMPLETE
- FAIL ANY STOP

### 1.1 First grandchild check

- DEFER

```bash
rd echo "grandchild first"
```

### 1.2 Second grandchild check

- DEFER

```bash
rd echo "grandchild second"
```
