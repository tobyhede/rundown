---
name: step-runbook-list
description: Compose child workflows with step-level runbook list

scenarios:
  completed:
    description: All child workflows pass
    commands:
      - rd run step-runbook-list.runbook.md
    result: COMPLETE
    expect:
      entered:
        - at: "1.1"
          description: "Runbook: inline-child-pass.runbook.md"
        - at: "1.2"
          description: "Runbook: inline-child-pass.runbook.md"
        - at: "1.3"
          description: "Runbook: inline-child-pass.runbook.md"
      steps:
        - runbook: inline-child-pass.runbook.md
          from: "1"
          action: COMPLETE
          result: PASS
        - runbook: inline-child-pass.runbook.md
          from: "1"
          action: COMPLETE
          result: PASS
        - runbook: inline-child-pass.runbook.md
          from: "1"
          action: COMPLETE
          result: PASS

  child-fails:
    description: First child fails (FAIL STOP stops the child) but the parent's FAIL ANY absorbs it non-terminally and defers to the next sibling, so `rd fail` exits 0 (the orchestrated workflow is still progressing); after the remaining children pass, FAIL ANY aggregates to STOP
    commands:
      - rd run --prompted step-runbook-list.runbook.md
      - rd fail --run ${RUN_ID_2}
      - rd pass --run ${RUN_ID_3}
      - rd pass --run ${RUN_ID_4}
    result: STOP
tags:
  - composition
---

Step-level runbook list shorthand below is equivalent
to `### 1.1` with the same runbook list.

## 1. Verify

- PASS ALL CONTINUE
- FAIL ANY STOP "Verification failed"
- inline-child-pass.runbook.md
- inline-child-pass.runbook.md
- inline-child-pass.runbook.md
