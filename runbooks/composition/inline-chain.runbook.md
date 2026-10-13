---
name: inline-chain
description: An inline chain two deep, driven end to end by the root's Owner Token
tags:
  - composition
  - inline

scenarios:
  two-deep-completes:
    description: The token targets the deepest running inline child (the grandchild), so the root's own substep is INVALID_STEP; passing the grandchild completes it, the middle Collects it and completes, and the root Collects the middle and completes
    commands:
      - rd run inline-chain.runbook.md
      - "! rd pass --token ${TOKEN} --step 1.1"
      - rd pass --token ${TOKEN} --step Check
    result: COMPLETE
    expect:
      errors:
        - code: INVALID_STEP
          command: pass

  two-deep-fails:
    description: Failing the grandchild stops it; the middle Collects the fail and stops, and the root Collects that and stops
    commands:
      - rd run inline-chain.runbook.md
      - "! rd fail --token ${TOKEN} --step Check"
    result: STOP
---

# Inline Chain

## 1. Compose

- PASS ALL COMPLETE
- FAIL ANY STOP

### 1.1 Middle

- inline-chain-middle.runbook.md
