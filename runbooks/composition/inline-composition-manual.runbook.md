---
name: inline-composition-manual
description: Parent whose inline child waits for the operator, driven by the parent's own Owner Token
tags:
  - composition
  - inline

scenarios:
  fail-drives-inline-stop:
    description: An operator fail on the waiting inline child stops it; the parent Collects the fail, aggregates FAIL ANY STOP and stops
    commands:
      - rd run inline-composition-manual.runbook.md
      - "! rd fail --token ${TOKEN} --step Check"
    result: STOP

  parent-step-refused-while-child-runs:
    description: While the inline child runs, the token targets the child, so a --step naming the parent's substep is INVALID_STEP; passing the child's step lets the parent continue
    commands:
      - rd run inline-composition-manual.runbook.md
      - "! rd pass --token ${TOKEN} --step 1.1"
      - rd pass --token ${TOKEN} --step Check
      - rd pass --token ${TOKEN} --step 2
    result: COMPLETE
    expect:
      errors:
        - code: INVALID_STEP
          command: pass
---

# Inline Composition (Manual)

## 1. Review

- PASS ALL CONTINUE
- FAIL ANY STOP

### 1.1 Manual gate

- inline-child-manual.runbook.md

## 2. Done

- PASS COMPLETE
- FAIL STOP

All reviews complete.
