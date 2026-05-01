---
name: agent-dispatch-orchestrator
description: One orchestrator claims and completes multiple delegated child runbooks by claim id
tags:
  - test
  - agent-dispatch

scenarios:
  same-agent-two-claims:
    description: Same orchestrator claims two children and completes each by explicit claim id
    commands:
      - rd run --prompted orchestrator.runbook.md
      - rd delegate agent-child-prompted.runbook.md --step 1.1
      - rd delegate agent-child-prompted.runbook.md --step 1.2
      - rd claim ${TOKEN}
      - rd claim ${TOKEN_2}
      - rd pass --claim-id ${CLAIM_ID_2}
      - rd pass --claim-id ${CLAIM_ID}
      - rd collect
    result: COMPLETE
---

# One orchestrator controls multiple delegated children by claim id

## 1. Fan out to claimed children

- PASS ALL COMPLETE
- FAIL ANY STOP

### 1.1 First child

- agent-child-prompted.runbook.md

### 1.2 Second child

- agent-child-prompted.runbook.md
