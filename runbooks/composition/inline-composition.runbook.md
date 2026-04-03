---
name: inline-composition
description: Parent runbook exercising inline child execution (rd run --step)
tags:
  - composition
  - inline

scenarios:
  inline-pass:
    description: Inline child auto-passes, parent completes
    commands:
      - rd run --prompted inline-composition.runbook.md
      - rd run inline-child-pass.runbook.md --step 1.1
      - rd pass
      - rd pass
    result: COMPLETE

  inline-fail:
    description: Child auto-fails at 1.1 triggering FAIL ANY STOP; rd pass on 1.2 drives aggregation surfacing the failure
    commands:
      - rd run --prompted inline-composition.runbook.md
      - rd run inline-child-fail.runbook.md --step 1.1
      - rd pass
    result: STOP
---

# Inline Composition

Exercises inline child execution via `rd run --step` as an alternative to delegation.

## 1. Review

- PASS ALL CONTINUE
- FAIL ANY STOP

### 1.1 First review

First review task.

### 1.2 Second review

Second review task.

## 2. Done

- PASS COMPLETE

All reviews complete.
