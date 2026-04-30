---
name: agent-dispatch-orchestrator
description: One agent claims and completes multiple delegated child runbooks
tags:
  - test
  - agent-dispatch

scenarios:
  same-agent-two-claims:
    description: Same agent claims two children, completes stack top first, then returns to the earlier child
    commands:
      - rd run --prompted orchestrator.runbook.md
      - rd delegate agent-child-prompted.runbook.md --step 1.1
      - rd delegate agent-child-prompted.runbook.md --step 1.2
      - RD_AGENT_ID=orchestrator RD_SESSION_ID=agent-dispatch rd claim ${TOKEN}
      - RD_AGENT_ID=orchestrator RD_SESSION_ID=agent-dispatch rd claim ${TOKEN_2}
      - RD_AGENT_ID=orchestrator RD_SESSION_ID=agent-dispatch rd pass
      - RD_AGENT_ID=orchestrator RD_SESSION_ID=agent-dispatch rd pass
      - rd collect
    result: COMPLETE
---

# One orchestrator agent owns multiple delegated children as a stack

## 1. Fan out to agent-owned children

- PASS ALL COMPLETE
- FAIL ANY STOP

### 1.1 First child

- agent-child-prompted.runbook.md

### 1.2 Second child

- agent-child-prompted.runbook.md
