---
name: agent-dispatch-sibling-fan-out
description: Two different agents claim sibling delegated child runbooks
tags:
  - test
  - agent-dispatch

scenarios:
  distinct-agents-complete-siblings:
    description: Two sibling agents complete their own children without crossing ownership
    commands:
      - rd run --prompted sibling-fan-out.runbook.md
      - rd delegate agent-child-prompted.runbook.md --step 1.1
      - rd delegate agent-child-prompted.runbook.md --step 1.2
      - RD_AGENT_ID=agent-one RD_SESSION_ID=sibling-session rd claim ${TOKEN}
      - RD_AGENT_ID=agent-two RD_SESSION_ID=sibling-session rd claim ${TOKEN_2}
      - RD_AGENT_ID=agent-one RD_SESSION_ID=sibling-session rd pass
      - RD_AGENT_ID=agent-two RD_SESSION_ID=sibling-session rd pass
      - rd collect
    result: COMPLETE
---

# Sibling agents own separate delegated children

## 1. Fan out to sibling agents

- PASS ALL COMPLETE
- FAIL ANY STOP

### 1.1 Agent one child

- agent-child-prompted.runbook.md

### 1.2 Agent two child

- agent-child-prompted.runbook.md
