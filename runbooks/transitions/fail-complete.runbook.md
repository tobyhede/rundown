---
name: fail-complete
description: FAIL COMPLETE finishes the runbook on failure
tags:
  - transitions

scenarios:
  completed:
    description: Step fails, runbook completes via FAIL COMPLETE
    commands:
      - rd run --prompted fail-complete.runbook.md
      - rd fail
    result: COMPLETE
---

# FAIL COMPLETE

FAIL: COMPLETE finishes the runbook when a step fails.
Useful for handled failures or early exit success.

## 1. Check condition

- PASS CONTINUE
- FAIL COMPLETE "Completed with warnings"

```bash
rd echo "check condition"
```
