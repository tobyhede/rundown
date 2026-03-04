---
name: for-nested-transitions
description: Iteration results aggregate via PASS ALL and FAIL ANY
tags:
  - for-loops
scenarios:
  completed:
    description: All iterations pass, PASS ALL continues
    commands:
      - rd run for-nested-transitions.runbook.md
    result: COMPLETE
  stopped:
    description: Second iteration fails, FAIL ANY triggers STOP on parent step
    commands:
      - rd run --prompted for-nested-transitions.runbook.md
      - rd pass
      - rd fail
    result: STOP
---

# FOR Nested Transitions

## 1. Validate items

- FOR item IN 1 TO 3
- PASS ALL CONTINUE
- FAIL ANY STOP

### 1.1 Check {{item}}

- PASS CONTINUE
- FAIL BREAK

```bash
rd echo "item={{item}}"
```

## 2. Finalize

- PASS COMPLETE

```bash
rd echo "done"
```
