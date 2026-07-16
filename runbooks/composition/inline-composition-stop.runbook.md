---
name: inline-composition-stop
description: Parent whose single inline substep aggregates FAIL ANY STOP, so an inline child's failure propagates a parent STOP during the driver's own pass
tags:
  - composition
  - inline

scenarios:
  run-drives-inline-stop:
    description: rd run --step drives an auto-failing inline child; advancing the single-substep parent aggregates FAIL ANY STOP and the parent stops during the run's propagation (no follow-up pass needed)
    commands:
      - rd run --prompted inline-composition-stop.runbook.md
      - rd run inline-child-fail.runbook.md --step 1.1
    result: STOP

  goto-drives-inline-stop:
    description: goto drives a waiting inline child to a FAIL STOP terminal; advancing the parent aggregates FAIL ANY STOP and the parent stops
    commands:
      - rd run --prompted inline-composition-stop.runbook.md
      - rd run inline-child-goto-stop.runbook.md --step 1.1
      - rd goto 2 --claim-id ${RUN_CLAIM_ID_2}
    result: STOP

  fail-drives-inline-stop:
    description: An operator fail on a waiting inline child stops it; advancing the parent aggregates FAIL ANY STOP and the parent stops
    commands:
      - rd run --prompted inline-composition-stop.runbook.md
      - rd run inline-child-manual.runbook.md --step 1.1
      - rd fail --claim-id ${RUN_CLAIM_ID_2}
    result: STOP
---

# Inline Composition (Stop)

Exercises inline child execution where the composing parent has a **single**
inline substep under `FAIL ANY STOP`. Because the substep is the only one in the
step, resolving it `fail` aggregates immediately — the parent reaches a STOP
terminal *during* the driving command's propagation pass (`rd run --step`,
`rd goto`, or `rd fail`), rather than on a later aggregation `rd pass`.

## 1. Review

- PASS ALL CONTINUE
- FAIL ANY STOP

### 1.1 Inline gate

Run the inline gate.

## 2. Done

- PASS COMPLETE

All reviews complete.
