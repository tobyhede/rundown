---
name: agent-dispatch-ownership-refusal
description: Agent-owned delegated children refuse anonymous or cross-agent control
tags:
  - test
  - agent-dispatch

scenarios:
  owned-stash-refuses-anonymous-pop:
    description: Anonymous pop and cross-agent claim fail while the owning agent can restore and complete the child
    commands:
      - rd run --prompted ownership-refusal.runbook.md
      - rd delegate agent-child-prompted.runbook.md --step 1.1
      - RD_AGENT_ID=agent-a RD_SESSION_ID=refusal-session rd claim ${TOKEN}
      - RD_AGENT_ID=agent-a RD_SESSION_ID=refusal-session rd stash
      - "! rd pop"
      - "! RD_AGENT_ID=agent-b RD_SESSION_ID=refusal-session rd claim ${TOKEN}"
      - RD_AGENT_ID=agent-a RD_SESSION_ID=refusal-session rd pop
      - RD_AGENT_ID=agent-a RD_SESSION_ID=refusal-session rd pass
      - rd collect
    result: COMPLETE
---

# Agent-owned children reject anonymous and cross-agent control

## 1. Delegate one owned child

- PASS ALL COMPLETE
- FAIL ANY STOP

### 1.1 Owned child

- agent-child-prompted.runbook.md
