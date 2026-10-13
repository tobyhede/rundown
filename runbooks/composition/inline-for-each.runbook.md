---
name: inline-for-each
description: An inline substep inside a FOR loop reserves one child per iteration
tags:
  - composition
  - inline
  - for-loops

scenarios:
  child-per-iteration:
    description: Each iteration enters the substep's frame afresh and launches its own child; passing each child advances the loop, and the parent completes after the loop
    commands:
      - rd run inline-for-each.runbook.md
      - rd pass --token ${TOKEN} --step Check
      - rd pass --token ${TOKEN} --step Check
      - rd pass --token ${TOKEN} --step 2
    result: COMPLETE
---

# Inline FOR Each

## 1. Each item

- FOR i IN 1 TO 2
- PASS ALL CONTINUE
- FAIL ANY STOP

### 1.1 Child

- inline-child-manual.runbook.md

## 2. Done

- PASS COMPLETE
- FAIL STOP

All items done.
