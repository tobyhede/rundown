---
name: substep-retry
description: RETRY on a substep that fails then succeeds
tags:
  - substeps
  - retries

scenarios:
  after-retry:
    description: Substep 1.1 fails then retries and succeeds, completes via 1.2
    commands:
      - rd run substep-retry.runbook.md
    result: COMPLETE
  immediate:
    description: Pass both substeps directly in prompted mode
    commands:
      - rd run --prompted substep-retry.runbook.md
      - rd pass
      - rd pass
    result: COMPLETE
---

# Substep Retry

RETRY on a substep that fails then succeeds on retry.

## 1. Parent

### 1.1 Flaky substep

- PASS CONTINUE
- FAIL RETRY 2 STOP

```bash
rd echo --result fail --result pass
```

### 1.2 Final substep

- PASS COMPLETE

```bash
rd echo "done"
```
