---
name: fail-all-standalone
description: FAIL ALL STOP fires only when every substep fails
tags:
  - transitions
scenarios:
  completed:
    description: One substep passes so PASS ANY continues
    commands:
      - rd run --prompted fail-all-standalone.runbook.md
      - rd fail
      - rd pass
      - rd pass
    result: COMPLETE
  stopped:
    description: All substeps fail and FAIL ALL stops
    commands:
      - rd run --prompted fail-all-standalone.runbook.md
      - rd fail
      - rd fail
    result: STOP
---

# FAIL ALL Standalone

## 1. Optimistic check

- PASS ANY CONTINUE
- FAIL ALL STOP

### 1.1 First check

```bash
rd echo "check one"
```

### 1.2 Second check

```bash
rd echo "check two"
```

## 2. Done

- PASS COMPLETE

```bash
rd echo "completed"
```
