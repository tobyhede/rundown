---
name: delegate-claim-parent-terminal
description: Claimed-child writes fail once the parent runbook is terminal
tags:
  - delegation
  - claim-id

scenarios:
  pass-after-parent-complete:
    description: pass --claim-id fails after the parent has completed
    commands:
      - true delegation-child-manual-three-step.runbook.md
      - rd run --prompted delegate-claim-parent-terminal.runbook.md
      - rd claim ${TOKEN}
      - rd complete --claim-id ${RUN_CLAIM_ID}
      - "! rd pass --claim-id ${CLAIM_ID}"
    expect:
      result: COMPLETE
      errors:
        - code: CLAIMED_RUNBOOK_UNAVAILABLE
          command: pass
          error: does not exist
  fail-after-parent-complete:
    description: fail --claim-id fails after the parent has completed
    commands:
      - true delegation-child-manual-three-step.runbook.md
      - rd run --prompted delegate-claim-parent-terminal.runbook.md
      - rd claim ${TOKEN}
      - rd complete --claim-id ${RUN_CLAIM_ID}
      - "! rd fail --claim-id ${CLAIM_ID}"
    expect:
      result: COMPLETE
      errors:
        - code: CLAIMED_RUNBOOK_UNAVAILABLE
          command: fail
          error: does not exist
  goto-after-parent-complete:
    description: goto --claim-id fails after the parent has completed
    commands:
      - true delegation-child-manual-three-step.runbook.md
      - rd run --prompted delegate-claim-parent-terminal.runbook.md
      - rd claim ${TOKEN}
      - rd complete --claim-id ${RUN_CLAIM_ID}
      - "! rd goto 3 --claim-id ${CLAIM_ID}"
    expect:
      result: COMPLETE
      errors:
        - code: CLAIMED_RUNBOOK_UNAVAILABLE
          command: goto
          error: does not exist
  stop-after-parent-complete:
    description: stop --claim-id fails after the parent has completed
    commands:
      - true delegation-child-manual-three-step.runbook.md
      - rd run --prompted delegate-claim-parent-terminal.runbook.md
      - rd claim ${TOKEN}
      - rd complete --claim-id ${RUN_CLAIM_ID}
      - "! rd stop --claim-id ${CLAIM_ID}"
    expect:
      result: COMPLETE
      errors:
        - code: CLAIMED_RUNBOOK_UNAVAILABLE
          command: stop
          error: does not exist
  complete-after-parent-complete:
    description: complete --claim-id fails after the parent has completed
    commands:
      - true delegation-child-manual-three-step.runbook.md
      - rd run --prompted delegate-claim-parent-terminal.runbook.md
      - rd claim ${TOKEN}
      - rd complete --claim-id ${RUN_CLAIM_ID}
      - "! rd complete --claim-id ${CLAIM_ID}"
    expect:
      result: COMPLETE
      errors:
        - code: CLAIMED_RUNBOOK_UNAVAILABLE
          command: complete
          error: does not exist
---

# Claimed Child Writes Fail after Parent Completion

Claim-id targeted write commands fail closed when their parent runbook has
already reached a terminal lifecycle.

## 1. Delegated child

- DELEGATE
- PASS ALL COMPLETE
- FAIL ANY STOP

### 1.1 Child task

- delegation-child-manual-three-step.runbook.md
