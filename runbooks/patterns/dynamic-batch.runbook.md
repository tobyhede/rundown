---
name: dynamic-batch
description: Dynamic batch processing with {n} substep pattern for iteration

scenarios:
  single-item:
    description: Process one item and complete
    commands:
      - rd run --prompted dynamic-batch.runbook.md
      - rd pass
      - rd fail
    result: COMPLETE
  multiple-items:
    description: Process multiple items before completing
    commands:
      - rd run --prompted dynamic-batch.runbook.md
      - rd pass
      - rd pass
      - rd fail
    result: COMPLETE
---

# Dynamic Batch Processing

## 1. Process Files

### 1.{n} Process Item

**Prompt:** Process item {n}.

```bash
./process.sh item_{n}.dat
```
