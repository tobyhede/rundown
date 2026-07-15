---
name: inline-child-manual
description: Child with a single manual step that waits for the operator (inline composition target for operator-driven propagation)
tags:
  - composition

scenarios:
  manual-fail:
    description: Child waits for the operator; fail STOPs it
    commands:
      - rd run --prompted inline-child-manual.runbook.md
      - rd fail
    result: STOP
---

# Inline Child (Manual)

Child runbook used as an inline composition target for operator-driven failure
propagation. Its single step carries no command, so the run loop waits for the
operator to `rd pass` / `rd fail`.

## 1. Check

- PASS COMPLETE
- FAIL STOP

Check manually.
