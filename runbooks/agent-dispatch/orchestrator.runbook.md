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
      - rd claim ${TOKEN}
      - rd claim ${TOKEN_2}
      - rd pass --claim-capability ${CLAIM_CAPABILITY_2}
      - rd pass --claim-capability ${CLAIM_CAPABILITY}
      - rd collect --run-capability ${RUN_CAPABILITY}
    result: COMPLETE
---

# One orchestrator controls multiple delegated children by claim id

## 1. Fan out to claimed children

- DELEGATE
- PASS ALL COMPLETE
- FAIL ANY STOP

### 1.1 First child

- agent-child-prompted.runbook.md

### 1.2 Second child

- agent-child-prompted.runbook.md
