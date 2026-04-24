---
name: defer-lastaction-overwrite
description: Aggregated terminal transition overwrites the last DEFER lastAction with COMPLETE + aggregated
tags:
  - transitions
  - defer
  - aggregation

scenarios:
  overwrite-visible:
    description: Both substeps emit DEFER; the final transition's action is COMPLETE (not DEFER) with aggregated true
    commands:
      - rd run defer-lastaction-overwrite.runbook.md
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

# DEFER lastAction Overwrite

Substeps 1.1 and 1.2 both DEFER. The runtime tags 1.1's transition with
`action: DEFER`. On 1.2's transition the parent's PASS ALL aggregation
resolves; the compiler overwrites the terminal transition's lastAction so
consumers observe `action: COMPLETE, aggregated: true` — not the raw
`DEFER`. This pins down compiler.ts around the aggregation-emit site.

## 1. Validate

- PASS ALL COMPLETE
- FAIL ANY STOP

### 1.1 First check

- DEFER

```bash
rd echo "first"
```

### 1.2 Second check

- DEFER

```bash
rd echo "second"
```
