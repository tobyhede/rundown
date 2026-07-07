---
name: delegate-substep-list
description: Delegation from H3 substeps defined as pure runbook list bodies (no prose)
tags:
  - delegation

scenarios:
  single-pass:
    description: Single H3 runbook-list substep delegated from auto-issued frontier; child step passed explicitly
    commands:
      - rd run --prompted delegate-substep-list.runbook.md
      - rd claim ${TOKEN}
      - rd pass --claim-id ${CLAIM_ID}
      - rd collect --claim-id ${RUN_CLAIM_ID}
    expect:
      result: COMPLETE
      steps:
        - runbook: delegate-substep-list.runbook.md
          from: "1.1"
          action: COMPLETE
          result: PASS

  step-inferred-runbook:
    description: Delegate token is auto-issued from substep body; child step passed explicitly
    commands:
      - rd run --prompted delegate-substep-list.runbook.md
      - rd claim ${TOKEN}
      - rd pass --claim-id ${CLAIM_ID}
      - rd collect --claim-id ${RUN_CLAIM_ID}
    expect:
      result: COMPLETE
      steps:
        - runbook: delegate-substep-list.runbook.md
          from: "1.1"
          action: COMPLETE
          result: PASS
---

# Delegate Substep List

Parent runbook whose substep is defined as a pure runbook list body (no prose body text).
The substep's runbook reference is resolved from the authored `DELEGATE` runbook list body.

## 1. Execute workflow

- PASS ALL COMPLETE
- FAIL ANY STOP

### 1.1 Child task

- DELEGATE
- delegation-child-manual-one-step.runbook.md
