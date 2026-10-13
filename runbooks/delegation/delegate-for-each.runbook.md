---
name: delegate-for-each
description: FOR + DELEGATE reserves one child per iteration, each with its own ticket
tags:
  - delegation
  - for-loops

scenarios:
  completed:
    description: Each iteration's child is claimed, passed and Collected; the parent's --step inside the loop needs --index
    commands:
      - rd run delegate-for-each.runbook.md
      - rd claim ${TICKET}
      - rd pass --token ${CHILD_TOKEN} --step Check
      - rd collect --token ${TOKEN}
      - "! rd pass --token ${TOKEN} --step 1.1"
      - rd claim ${TICKET_2}
      - rd pass --token ${CHILD_TOKEN_2} --step Check
      - rd collect --token ${TOKEN}
    result: COMPLETE
    expect:
      errors:
        - code: INVALID_STEP
          command: pass
      collected:
        - step: '1.1'
          index: 1
          status: collected
        - step: '1.1'
          index: 2
          status: collected

  decided-by-index:
    description: The owner decides the second iteration's delegated substep by hand with --index; its unclaimed child is never Collected
    commands:
      - rd run delegate-for-each.runbook.md
      - rd claim ${TICKET}
      - rd pass --token ${CHILD_TOKEN} --step Check
      - rd collect --token ${TOKEN}
      - rd pass --token ${TOKEN} --step 1.1 --index 2
    result: COMPLETE
---

# Delegate (For Each)

## 1. Process each item

- FOR item IN 1 TO 2
  - PASS DEFER
  - FAIL BREAK
- DELEGATE
- PASS ALL COMPLETE
- FAIL ANY STOP

- delegation-child-manual.runbook.md
