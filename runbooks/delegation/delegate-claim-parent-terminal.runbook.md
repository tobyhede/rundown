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
        - code: DELEGATION_SUPERSEDED
          command: pass
          error: moved past this delegation (parent-ended)
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
        - code: DELEGATION_SUPERSEDED
          command: fail
          error: moved past this delegation (parent-ended)
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
        - code: DELEGATION_SUPERSEDED
          command: goto
          error: moved past this delegation (parent-ended)
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
        - code: DELEGATION_SUPERSEDED
          command: stop
          error: moved past this delegation (parent-ended)
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
        - code: DELEGATION_SUPERSEDED
          command: complete
          error: moved past this delegation (parent-ended)
---

# Claimed Child Writes Fail after Parent Completion

Claim-id targeted write commands fail closed when their parent runbook has
already reached a terminal lifecycle. The refusal is `DELEGATION_SUPERSEDED`
(RD-825), naming `parent-ended` as the cause: the parent-side latch tombstoned
the bearer when the parent terminalized, and a tombstoned bearer is superseded,
not unknown. Reporting it as a claim that does not exist would read as a
mistyped id and invite a retry that can never succeed.

## 1. Delegated child

- DELEGATE
- PASS ALL COMPLETE
- FAIL ANY STOP

### 1.1 Child task

- delegation-child-manual-three-step.runbook.md
