---
name: dynamic-step-dynamic-substeps
description: Demonstrates doubly-dynamic iteration with {N}.{n} pattern

scenarios:
  item-failure:
    description: Item processing fails and stops workflow
    commands:
      - rd run --prompted dynamic-step-dynamic-substeps.runbook.md
      - rd fail
    result: STOP
  single-item-success:
    description: Single item passes and advances to next substep instance
    commands:
      - rd run --prompted dynamic-step-dynamic-substeps.runbook.md
      - rd pass
    result: step_1 substep 2
---

# Dynamic Step With Dynamic Substeps

Demonstrates doubly-dynamic iteration with {N}.{n} pattern.

## {N}. Process Batch

### {N}.{n} Process Item
- PASS: GOTO NEXT
- FAIL: STOP

Process each item in batch N.

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
