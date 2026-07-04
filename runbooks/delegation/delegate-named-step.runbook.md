---
name: delegate-named-step
description: Named step with delegation — verifies delegation works with named step identifiers
tags:
  - delegation
  - named-steps
scenarios:
  completed:
    description: Named step delegates substep to child, child completes
    commands:
      - rd run delegate-named-step.runbook.md
      - rd claim ${TOKEN}
      - rd collect --run ${RUN_ID}
    result: COMPLETE
---

# Named Step Delegation

## Review. Code review

- DELEGATE
- PASS ALL COMPLETE
- FAIL ANY STOP

### Review.1 Automated check

- DELEGATE
- delegation-child-pass.runbook.md
