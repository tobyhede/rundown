---
name: delegate-fan-out
description: A step fanning out to four delegated children, Collected in any order
tags:
  - delegation

scenarios:
  all-terminal:
    description: Four sub-agents claim and pass; one collect after all are terminal applies all four and the step aggregates
    commands:
      - rd run delegate-fan-out.runbook.md
      - rd claim ${TICKET}
      - rd claim ${TICKET_2}
      - rd claim ${TICKET_3}
      - rd claim ${TICKET_4}
      - rd pass --token ${CHILD_TOKEN} --step Check
      - rd pass --token ${CHILD_TOKEN_2} --step Check
      - rd pass --token ${CHILD_TOKEN_3} --step Check
      - rd pass --token ${CHILD_TOKEN_4} --step Check
      - rd collect --token ${TOKEN}
      - rd pass --token ${TOKEN} --step 2
    result: COMPLETE
    expect:
      collected:
        - step: '1.1'
          status: collected
        - step: '1.2'
          status: collected
        - step: '1.3'
          status: collected
        - step: '1.4'
          status: collected
      steps:
        - from: '1.4'
          action: CONTINUE
          aggregated: true

  one-pending:
    description: With the first child still running, collect applies the other three and reports it pending; a later collect applies it and the step aggregates
    commands:
      - rd run delegate-fan-out.runbook.md
      - rd claim ${TICKET}
      - rd claim ${TICKET_2}
      - rd claim ${TICKET_3}
      - rd claim ${TICKET_4}
      - rd pass --token ${CHILD_TOKEN_2} --step Check
      - rd pass --token ${CHILD_TOKEN_3} --step Check
      - rd pass --token ${CHILD_TOKEN_4} --step Check
      - rd collect --token ${TOKEN}
      - rd pass --token ${CHILD_TOKEN} --step Check
      - rd collect --token ${TOKEN}
      - rd pass --token ${TOKEN} --step 2
    result: COMPLETE
    expect:
      collected:
        - step: '1.1'
          status: pending
        - step: '1.2'
          status: collected
        - step: '1.3'
          status: collected
        - step: '1.4'
          status: collected
        - step: '1.1'
          status: collected
        - step: '1.2'
          status: already_collected
---

# Delegate (Fan Out)

## 1. Review in parallel

- DELEGATE
- PASS ALL CONTINUE
- FAIL ANY STOP

- delegation-child-manual.runbook.md
- delegation-child-manual.runbook.md
- delegation-child-manual.runbook.md
- delegation-child-manual.runbook.md

## 2. Collate

- PASS COMPLETE
- FAIL STOP

Collate the four reviews.
