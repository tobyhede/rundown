---
name: pass-complete
description: PASS COMPLETE finishes the runbook on success
tags:
  - transitions

scenarios:
  completed:
    description: Step passes, runbook finishes via PASS COMPLETE
    commands:
      - rd run --prompted pass-complete.runbook.md
      - rd pass
    result: COMPLETE
---

# PASS COMPLETE

PASS: COMPLETE finishes the runbook immediately when a step succeeds.

## 1. Final check

- PASS COMPLETE "Finished successfully"
- FAIL STOP

```bash
rd echo "final check"
```

## 2. Unreachable step

- PASS COMPLETE

This step should never be reached.

```bash
rd echo --result fail
```
