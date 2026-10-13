---
name: delegation-child-manual
description: Delegation target whose one step waits for its owner (the claiming sub-agent)
tags:
  - delegation

scenarios:
  manual-pass:
    description: Run standalone, the owner passes the one step
    commands:
      - rd run delegation-child-manual.runbook.md
      - rd pass --token ${TOKEN} --step Check
    result: COMPLETE
---

# Delegation Child (Manual)

Delegation target driven by the sub-agent that claimed it. The step is named
`Check`, so a `--step` naming it cannot be mistaken for a step of a parent.

## Check

- PASS COMPLETE
- FAIL STOP

Check the delegated work.
