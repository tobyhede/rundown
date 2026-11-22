---
name: inline-delegation
description: Parent whose Inline Child delegates; the parent's token Collects into the child, which the parent then Collects implicitly
tags:
  - composition
  - inline
  - delegation

scenarios:
  collected-through-inline-child:
    description: The inline child's step entry issues the ticket; collect by the root token applies into the inline child, whose completion the parent Collects and continues
    commands:
      - rd run inline-delegation.runbook.md
      - rd claim ${TICKET}
      - rd pass --token ${CHILD_TOKEN} --step 1
      - rd collect --token ${TOKEN}
      - rd pass --token ${TOKEN} --step 2
    result: COMPLETE
    expect:
      collected:
        - step: '1.1'
          status: collected
          result: pass
---

# Inline Delegation

## 1. Compose

- PASS ALL CONTINUE
- FAIL ANY STOP

- inline-child-delegates.runbook.md

## 2. Done

- PASS COMPLETE
- FAIL STOP

All work collected.
