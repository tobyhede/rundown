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
      - true delegation-child-fail-once.runbook.md
      - rundown run --prompted delegate-claim-superseded.runbook.md
      - rundown goto 2 --claim-id ${RUN_CLAIM_ID}
      - "! rundown claim ${TOKEN}"
      - rundown complete --claim-id ${RUN_CLAIM_ID}
    expect:
      result: COMPLETE
      errors:
        - code: DELEGATION_SUPERSEDED
          command: claim
          error: moved past this delegation
  replacement-token-after-retry:
    description: RETRY supersedes the old claim once and issues a replacement token that remains claimable
    commands:
      - true delegation-child-fail-once.runbook.md
      - rundown run --allow-all delegate-claim-superseded.runbook.md
      - rundown --allow-all claim ${TOKEN}
      - rundown --allow-all collect --claim-id ${RUN_CLAIM_ID}
      - "! rundown pass --claim-id ${CLAIM_ID}"
      - rundown --allow-all claim ${TOKEN_2}
      - rundown --allow-all collect --claim-id ${RUN_CLAIM_ID}
    expect:
      result: COMPLETE
      steps:
        - action: RETRY
          from: 1.1
          result: FAIL
      errors:
        - code: CLAIMED_RUNBOOK_UNAVAILABLE
          command: pass
          error: does not exist
---

# Claiming a Superseded Delegation Fails

The durable two-sided latch refuses a claim once the parent has moved past the
delegation. Here the parent advances its top-level cursor beyond the delegating
step before the token is claimed, so `rundown claim` fails closed with
`DELEGATION_SUPERSEDED` — the token must not be retried.

## 1. Delegated child

- DELEGATE
- PASS ALL COMPLETE
- FAIL ANY RETRY 1 STOP

### 1.1 Child task

- delegation-child-fail-once.runbook.md

## 2. Continue past the delegation

The parent advances into this step, leaving the step 1 delegation behind.
