---
name: delegation-child-fail
description: Child runbook that auto-fails (delegation target)
tags:
  - delegation

scenarios:
  auto_fail:
    description: Child auto-executes and stops on failure
    commands:
      - rd run delegation-child-fail.runbook.md
    result: STOP
---

# Delegation Child (Fail)

Child runbook that auto-fails. Used as a delegation target for failure propagation scenarios.

## 1. Execute child task

- PASS COMPLETE
- FAIL STOP

```bash
rd echo --result fail "child task failed"
```
