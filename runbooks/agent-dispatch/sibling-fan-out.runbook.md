---
name: agent-dispatch-sibling-fan-out
description: Two sibling claims target separate delegated child runbooks
tags:
  - test
  - agent-dispatch

scenarios:
  distinct-agents-complete-siblings:
    description: Two sibling claims complete their own children without crossing targets
    commands:
      - rd run --prompted sibling-fan-out.runbook.md
      - rd delegate agent-child-prompted.runbook.md --step 1.1
      - rd delegate agent-child-prompted.runbook.md --step 1.2
      - rd claim ${TOKEN}
      - rd claim ${TOKEN_2}
      - rd pass --claim-id ${CLAIM_ID}
      - rd pass --claim-id ${CLAIM_ID_2}
      - rd collect
    result: COMPLETE
---

# Sibling claims target separate delegated children

## 1. Fan out to sibling claims

- PASS ALL COMPLETE
- FAIL ANY STOP

### 1.1 First claimed child

- agent-child-prompted.runbook.md

### 1.2 Second claimed child

- agent-child-prompted.runbook.md
