---
name: fail-stop
description: FAIL STOP halts the runbook on failure
tags:
  - transitions

scenarios:
  stopped:
    description: Step fails, runbook halts via explicit FAIL STOP
    commands:
      - rd run --prompted fail-stop.runbook.md
      - rd fail
    result: STOP
  completed:
    description: Step passes, runbook completes normally
    commands:
      - rd run --prompted fail-stop.runbook.md
      - rd pass
    result: COMPLETE
---

# FAIL STOP

Explicit FAIL: STOP halts the runbook when a step fails.

## 1. Critical step
- PASS: COMPLETE
- FAIL: STOP "Critical failure"

```bash
rd echo "critical step"
```
