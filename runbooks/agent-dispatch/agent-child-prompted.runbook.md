---
name: agent-child-prompted
description: Prompted child runbook for agent-dispatch ownership scenarios
tags:
  - test
  - agent-dispatch

scenarios:
  pass:
    description: Child can be completed manually
    commands:
      - rd run --prompted agent-child-prompted.runbook.md
      - rd pass
    result: COMPLETE
---

# Agent-dispatch child stays active until its owning agent passes it

## 1. Agent-owned work

- PASS COMPLETE
- FAIL STOP

The child intentionally has no command block so ownership scenarios can claim it
and then complete it with the agent-scoped `rd pass` command.
