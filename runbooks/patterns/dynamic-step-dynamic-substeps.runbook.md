---
name: dynamic-step-dynamic-substeps
description: Demonstrates doubly-dynamic iteration with {N}.{n} pattern

scenarios:
  stopped:
    description: Runbook STOPPED on fail
    commands:
      - rd run --prompted dynamic-step-dynamic-substeps.runbook.md
      - rd fail
      - rd fail
    result: STOP
  completed:
    description: Dynamic steps and substeps COMPLETE on fail recovery
    commands:
      - rd run --prompted dynamic-step-dynamic-substeps.runbook.md
      - rd pass
      - rd pass
      - rd fail
      - rd pass
    result: COMPLETE
---

# Dynamic Step With Dynamic Substeps

Demonstrates doubly-dynamic iteration with {N}.{n} pattern.

## {N}. Process Batch

### {N}.{n} Process Item
- PASS: GOTO NEXT
- FAIL: GOTO Cleanup

Process next item in batch.

```bash
rd echo "process item"
```

## Cleanup
- PASS: COMPLETE
- FAIL: STOP

Handle any failures.

```bash
rd echo "cleanup resources"
```
