---
name: mixed-modifiers
description: Demonstrates complex transition conditions with ALL/ANY modifiers
tags:
  - transitions

scenarios:
  completed:
    description: All steps pass through to completion
    commands:
      - rd run --prompted mixed-modifiers.runbook.md
      - rd pass
      - rd pass
      - rd pass
      - rd pass
    result: COMPLETE
  auto-execution:
    description: Step 2 passes, GOTOs step 4, completes
    commands:
      - rd run mixed-modifiers.runbook.md
    result: COMPLETE
---

# Complex Transitions

## 1. Aggregation

- PASS ALL CONTINUE
- FAIL ANY STOP "Failed"

```bash
rd echo --result pass
```

## 2. Optimistic

- PASS ANY GOTO 4
- FAIL ALL RETRY 3 STOP

```bash
rd echo --result pass
```

## 3. Empty

- PASS CONTINUE

```bash
rd echo --result pass
```

## 4. End

- PASS COMPLETE

```bash
rd echo --result pass
```
