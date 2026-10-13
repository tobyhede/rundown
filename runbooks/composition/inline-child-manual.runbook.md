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
      - rd fail --token ${TOKEN} --step Check
    result: STOP
---

# Inline Child (Manual)

Child runbook used as an inline composition target for operator-driven
propagation. Its single step carries no command, so the run loop waits for the
operator to `rundown pass` / `rundown fail`. The step is named `Check` so a
`--step` naming it cannot be mistaken for a step of the parent.

## Check

- PASS COMPLETE
- FAIL STOP

Check manually.
