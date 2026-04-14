---
name: delegate-substep-list
description: Delegation from H3 substeps defined as pure runbook list bodies (no prose)
tags:
  - delegation

scenarios:
  single-pass:
    description: Single H3 runbook-list substep delegated via full inference; child step passed explicitly
    commands:
      - rd run --prompted delegate-substep-list.runbook.md
      - rd delegate
      - rd claim ${TOKEN}
      - rd pass
    expect:
      result: COMPLETE
      steps:
        - runbook: delegate-substep-list.runbook.md
          from: "1.1"
          action: COMPLETE
          result: PASS

  step-inferred-runbook:
    description: Delegate with --step only; runbook inferred from substep body; child step passed explicitly
    commands:
      - rd run --prompted delegate-substep-list.runbook.md
      - rd delegate --step 1.1
      - rd claim ${TOKEN}
      - rd pass
    expect:
      result: COMPLETE
      steps:
        - runbook: delegate-substep-list.runbook.md
          from: "1.1"
          action: COMPLETE
          result: PASS

  child-fails:
    description: Child runbook fails, parent stops; child step failed explicitly
    commands:
      - rd run --prompted delegate-substep-list.runbook.md
      - rd delegate --step 1.1 delegation-child-fail.runbook.md
      - rd claim ${TOKEN}
      - rd fail
    expect:
      result: STOP
      steps:
        - runbook: delegate-substep-list.runbook.md
          from: "1.1"
          action: STOP
          result: FAIL
---

# Delegate Substep List

Parent runbook whose substep is defined as a pure runbook list body (no prose body text).
The substep's runbook reference is inferred by `rd delegate` from the substep's `runbooks` field.

## 1. Execute workflow

- PASS ALL COMPLETE
- FAIL ANY STOP

### 1.1 Child task

- delegation-child-pass.runbook.md
