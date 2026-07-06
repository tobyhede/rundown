---
name: delegate-substep-list-non-delegate
description: Runbook-list substeps without DELEGATE are not manual delegation targets
tags:
  - delegation
  - delegate-keyword

scenarios:
  reject-manual-delegate:
    description: rd delegate rejects a runbook-list substep that lacks DELEGATE
    commands:
      - rd run --prompted delegate-substep-list-non-delegate.runbook.md
      - "! rd delegate --step 1.1 --run-capability ${RUN_CAPABILITY}"
      - rd stop --run-capability ${RUN_CAPABILITY}
    expect:
      result: STOP
---

# Non-DELEGATE Runbook List Is Not Delegatable

The substep has a runbook reference but intentionally lacks `- DELEGATE`.

## 1. Execute workflow

- PASS ALL COMPLETE
- FAIL ANY STOP

### 1.1 Child task

- delegation-child-pass.runbook.md
