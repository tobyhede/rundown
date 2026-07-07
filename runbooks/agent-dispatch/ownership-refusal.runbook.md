---
name: agent-dispatch-ownership-refusal
description: Claimed delegated children use explicit claim ids for stash and completion
tags:
  - test
  - agent-dispatch

scenarios:
  claimed-stash-refuses-anonymous-pop:
    description: Anonymous pop fails while the claim id can restore and complete the child
    commands:
      - rd run --prompted ownership-refusal.runbook.md
      - rd claim ${TOKEN}
      - rd stash --claim-id ${CLAIM_ID}
      - "! rd pop"
      - rd pop --claim-id ${CLAIM_ID}
      - rd pass --claim-id ${CLAIM_ID}
      - rd collect --claim-id ${RUN_CLAIM_ID}
    result: COMPLETE
---

# Claimed children reject anonymous stash control

## 1. Delegate one claimed child

- DELEGATE
- PASS ALL COMPLETE
- FAIL ANY STOP

### 1.1 Owned child

- agent-child-prompted.runbook.md
