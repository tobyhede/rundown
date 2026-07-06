---
name: delegate-claim-parent-terminal
description: Claimed-child writes fail once the parent runbook is terminal
tags:
  - delegation
  - claim-id

scenarios:
  pass-after-parent-complete:
    description: pass --claim-capability fails after the parent has completed
    commands:
      - true delegation-child-manual-three-step.runbook.md
      - rd run --prompted delegate-claim-parent-terminal.runbook.md
      - rd claim ${TOKEN}
      - rd complete --run-capability ${RUN_CAPABILITY}
      - "! rd pass --claim-capability ${CLAIM_CAPABILITY}"
    expect:
      result: COMPLETE
      errors:
        - code: CLAIMED_RUNBOOK_UNAVAILABLE
          command: pass
          error: parent-ended
  fail-after-parent-complete:
    description: fail --claim-capability fails after the parent has completed
    commands:
      - true delegation-child-manual-three-step.runbook.md
      - rd run --prompted delegate-claim-parent-terminal.runbook.md
      - rd claim ${TOKEN}
      - rd complete --run-capability ${RUN_CAPABILITY}
      - "! rd fail --claim-capability ${CLAIM_CAPABILITY}"
    expect:
      result: COMPLETE
      errors:
        - code: CLAIMED_RUNBOOK_UNAVAILABLE
          command: fail
          error: parent-ended
  goto-after-parent-complete:
    description: goto --claim-capability fails after the parent has completed
    commands:
      - true delegation-child-manual-three-step.runbook.md
      - rd run --prompted delegate-claim-parent-terminal.runbook.md
      - rd claim ${TOKEN}
      - rd complete --run-capability ${RUN_CAPABILITY}
      - "! rd goto 3 --claim-capability ${CLAIM_CAPABILITY}"
    expect:
      result: COMPLETE
      errors:
        - code: CLAIMED_RUNBOOK_UNAVAILABLE
          command: goto
          error: parent-ended
  stop-after-parent-complete:
    description: stop --claim-capability fails after the parent has completed
    commands:
      - true delegation-child-manual-three-step.runbook.md
      - rd run --prompted delegate-claim-parent-terminal.runbook.md
      - rd claim ${TOKEN}
      - rd complete --run-capability ${RUN_CAPABILITY}
      - "! rd stop --claim-capability ${CLAIM_CAPABILITY}"
    expect:
      result: COMPLETE
      errors:
        - code: CLAIMED_RUNBOOK_UNAVAILABLE
          command: stop
          error: parent-ended
  complete-after-parent-complete:
    description: complete --claim-capability fails after the parent has completed
    commands:
      - true delegation-child-manual-three-step.runbook.md
      - rd run --prompted delegate-claim-parent-terminal.runbook.md
      - rd claim ${TOKEN}
      - rd complete --run-capability ${RUN_CAPABILITY}
      - "! rd complete --claim-capability ${CLAIM_CAPABILITY}"
    expect:
      result: COMPLETE
      errors:
        - code: CLAIMED_RUNBOOK_UNAVAILABLE
          command: complete
          error: parent-ended
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
