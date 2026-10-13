---
name: inline-chain-middle
description: The middle of an inline chain; composes a manual inline child of its own
tags:
  - composition
  - inline

scenarios:
  middle-completes:
    description: Run on its own, the middle's inline child waits for the operator and its pass completes both
    commands:
      - rd run inline-chain-middle.runbook.md
      - rd pass --token ${TOKEN} --step Check
    result: COMPLETE
---

# Inline Chain Middle

## Nest

- PASS ALL COMPLETE
- FAIL ANY STOP

- inline-child-manual.runbook.md
