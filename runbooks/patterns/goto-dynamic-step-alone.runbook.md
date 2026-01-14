---
name: goto-dynamic-step-alone
description: Demonstrates infinite retry pattern where FAIL causes step to restart (GOTO {N}) and only PASS exits the workflow

scenarios:
  retry-until-pass:
    description: Retries on fail until pass, then completes
    commands:
      - rd run --prompted goto-dynamic-step-alone.runbook.md
      - rd fail
      - rd pass
    result: COMPLETE
---

# GOTO Dynamic Step

Demonstrates infinite retry pattern. The step restarts on FAIL and only
exits on PASS (defaults to CONTINUE). Use for operations that should retry
indefinitely until an external condition causes failure.

## {N}. Dynamic
- FAIL: GOTO {N}

```bash
rd echo --result fail --result fail --result fail --result fail --result pass
```
