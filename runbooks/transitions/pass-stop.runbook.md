---
name: pass-stop
description: PASS STOP halts the runbook on success
tags:
  - transitions

scenarios:
  stopped:
    description: Step passes, runbook halts via PASS STOP
    commands:
      - rd run --prompted pass-stop.runbook.md
      - rd pass
    result: STOP

  forced-stop-command:
    description: Public rd stop forces STOP from an active prompted run
    commands:
      - rd run --prompted pass-stop.runbook.md
      - rd stop "operator stopped"
    result: STOP
---

# PASS STOP

PASS: STOP halts the runbook immediately when a step succeeds.

## 1. Critical check

- PASS STOP "Halted on success"
- FAIL CONTINUE

```bash
rd echo "critical check"
```
