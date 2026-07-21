---
name: delegate-claim-superseded
description: Claiming a delegation the parent advanced past is refused as superseded
tags:
  - delegation
  - claim-id

scenarios:
  claim-after-parent-advanced:
    description: claim is refused DELEGATION_SUPERSEDED after the parent advances its cursor past the delegation
    commands:
      - true delegation-child-manual-three-step.runbook.md
      - rd run --prompted delegate-claim-superseded.runbook.md
      - rd goto 2 --claim-id ${RUN_CLAIM_ID}
      - "! rd claim ${TOKEN}"
      - rd complete --claim-id ${RUN_CLAIM_ID}
    expect:
      result: COMPLETE
      errors:
        - code: DELEGATION_SUPERSEDED
          command: claim
          error: moved past this delegation
---

# Claiming a Superseded Delegation Fails

The durable two-sided latch refuses a claim once the parent has moved past the
delegation. Here the parent advances its top-level cursor beyond the delegating
step before the token is claimed, so `rundown claim` fails closed with
`DELEGATION_SUPERSEDED` — the token must not be retried.

## 1. Delegated child

- DELEGATE
- PASS ALL COMPLETE
- FAIL ANY STOP

### 1.1 Child task

- delegation-child-manual-three-step.runbook.md

## 2. Continue past the delegation

The parent advances into this step, leaving the step 1 delegation behind.
