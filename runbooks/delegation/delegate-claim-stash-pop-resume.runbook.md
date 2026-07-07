---
name: delegate-claim-stash-pop-resume
description: Claimed children can be stashed, popped, and resumed by claim id
tags:
  - delegation
  - claim-id

scenarios:
  stash-pop-complete:
    description: A stashed claimed child rejects writes until popped, then resumes by claim id
    commands:
      - true delegation-child-manual-three-step.runbook.md
      - rd run --prompted delegate-claim-stash-pop-resume.runbook.md
      - rd claim ${TOKEN}
      - rd stash --claim-id ${CLAIM_ID}
      - "! rd pass --claim-id ${CLAIM_ID}"
      - rd pop --claim-id ${CLAIM_ID}
      - rd complete --claim-id ${CLAIM_ID}
      - rd collect --claim-id ${RUN_CLAIM_ID}
    expect:
      result: COMPLETE
      errors:
        - code: CLAIMED_RUNBOOK_UNAVAILABLE
          command: pass
          error: currently stashed
      steps:
        - runbook: delegate-claim-stash-pop-resume.runbook.md
          action: COMPLETE
          result: PASS
---

# Claimed Children Stash Pop and Resume by Claim ID

A stashed claimed child must be explicitly popped before write commands can
resume against its claim id.

## 1. Delegated child

- DELEGATE
- PASS ALL COMPLETE
- FAIL ANY STOP

### 1.1 Child task

- delegation-child-manual-three-step.runbook.md
