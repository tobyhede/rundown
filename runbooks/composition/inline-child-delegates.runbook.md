---
name: inline-child-delegates
description: Inline composition target whose one step delegates child-task (an inline child that delegates)
tags:
  - composition
  - delegation

scenarios:
  delegated:
    description: Run standalone, the delegated child-task is claimed, passed and Collected
    commands:
      - rd run inline-child-delegates.runbook.md
      - rd claim ${TICKET}
      - rd pass --token ${CHILD_TOKEN} --step 1
      - rd collect --token ${TOKEN}
    result: COMPLETE
---

# Inline Child (Delegates)

## 1. Delegate the task

- DELEGATE
- PASS ALL COMPLETE
- FAIL ANY STOP

- child-task.runbook.md
