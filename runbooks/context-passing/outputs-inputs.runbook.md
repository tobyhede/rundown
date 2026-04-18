---
name: outputs-inputs
description: "Step 1 OUTPUTS stored in context, step 2 value injected into template vars via frontmatter inputs"
tags:
  - context-passing
scenarios:
  pass-stores-outputs:
    description: Step 1 passes — OUTPUTS stored, step 2 value injected, runbook completes
    commands:
      - rd run --prompted outputs-inputs.runbook.md --var ContextId=scenario1
      - rd pass
      - rd pass
    result: COMPLETE
  fail-missing-inputs:
    description: Step 1 fails — no OUTPUTS stored, step 2 renders literally, runbook still completes
    commands:
      - rd run --prompted outputs-inputs.runbook.md --var ContextId=scenario2
      - rd fail
      - rd pass
    result: COMPLETE
---

# Context Passing

## 1. Produce output
- PASS CONTINUE
- FAIL CONTINUE
- OUTPUTS
  - Message "hello from step 1"

## 2. Consume input
- PASS COMPLETE
- FAIL STOP

The message is: {{Message}}
