---
name: substep-defer-shorthand
description: DEFER shorthand expands to PASS DEFER + FAIL DEFER
tags:
  - substeps
scenarios:
  completed:
    description: Both substeps DEFER via shorthand, parent PASS ALL fires COMPLETE
    commands:
      - rd run substep-defer-shorthand.runbook.md
    result: COMPLETE
    expect:
      steps:
        - from: "1.1"
          action: DEFER
          result: PASS
        - from: "1.2"
          action: DEFER
          result: PASS
---

# Substep DEFER Shorthand

`- DEFER` is shorthand for `- PASS: DEFER` + `- FAIL: DEFER`.

## 1. Validate

- PASS ALL: COMPLETE
- FAIL ANY: STOP

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
