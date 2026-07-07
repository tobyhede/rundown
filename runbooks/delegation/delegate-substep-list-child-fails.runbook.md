---
name: delegate-substep-list-child-fails
description: Delegation from H3 substeps defined as pure runbook list bodies to a failing child
tags:
  - delegation

scenarios:
  child-fails:
    description: Child runbook fails, parent stops; child step failed explicitly
    commands:
      - rd run --prompted delegate-substep-list-child-fails.runbook.md
      - rd claim ${TOKEN}
      - rd fail --claim-id ${CLAIM_ID}
      - rd collect --claim-id ${RUN_CLAIM_ID}
    expect:
      result: STOP
      steps:
        - runbook: delegate-substep-list-child-fails.runbook.md
          from: "1.1"
          action: STOP
          result: FAIL
---

# Delegate Substep List (Failing Child)

Parent runbook whose substep is defined as a pure runbook list body (no prose body text).

## 1. Execute workflow

- PASS ALL COMPLETE
- FAIL ANY STOP

### 1.1 Child task

- DELEGATE
- delegation-child-fail.runbook.md
