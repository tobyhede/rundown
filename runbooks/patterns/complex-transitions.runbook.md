---
name: complex-transitions
description: Demonstrates complex transition conditions with ALL/ANY modifiers

scenarios:
  success:
    description: All steps pass through to completion
    commands:
      - rd run --prompted complex-transitions.runbook.md
      - rd pass
      - rd pass
      - rd pass
      - rd pass
    result: COMPLETE
---

# Complex Transitions

## 1. Aggregation
- PASS ALL: CONTINUE
- FAIL ANY: STOP "Failed"

```bash
rd echo --result pass
```


## 2. Optimistic
- PASS ANY: GOTO 4
- FAIL ALL: RETRY 3

```bash
rd echo --result pass
```


## 3. Empty
- PASS: CONTINUE

```bash
rd echo --result pass
```


## 4. End
- PASS: COMPLETE

```bash
rd echo --result pass
```

