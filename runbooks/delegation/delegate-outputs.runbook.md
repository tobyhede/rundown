---
name: delegate-outputs
description: A delegated child's frontmatter outputs flow into the parent at Collect
tags:
  - delegation
  - context-passing

scenarios:
  outputs-flow:
    description: The child completes on its own when claimed; collect applies its pass and its Verdict output, which renders into the parent's next step
    commands:
      - rd run delegate-outputs.runbook.md
      - rd claim ${TICKET}
      - rd collect --token ${TOKEN}
      - rd pass --token ${TOKEN} --step 2
    result: COMPLETE
    expect:
      entered:
        - at: '2'
          description: Verdict approved
---

# Delegate (Outputs)

## 1. Delegate the review

- DELEGATE
- PASS ALL CONTINUE
- FAIL ANY STOP

- delegation-child-pass.runbook.md

## 2. Verdict {{ Verdict }}

- PASS COMPLETE
- FAIL STOP

Act on the delegated verdict.
