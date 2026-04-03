---
name: inline-child-fail
description: Child runbook that auto-fails (inline composition target)
tags:
  - composition

scenarios:
  auto-fail:
    description: Child auto-executes and stops on failure
    commands:
      - rd run inline-child-fail.runbook.md
    result: STOP
---

# Inline Child (Fail)

Child runbook that auto-fails. Used as an inline composition target for failure propagation scenarios.

## 1. Execute child task

- PASS COMPLETE
- FAIL STOP

```bash
rd echo --result fail "child task failed"
```
