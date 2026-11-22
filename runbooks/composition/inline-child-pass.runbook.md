---
name: inline-child-pass
description: Child runbook that auto-passes (inline composition target)
tags:
  - composition

scenarios:
  auto-pass:
    description: Child auto-executes and completes
    commands:
      - rd run inline-child-pass.runbook.md
    result: COMPLETE
---

# Inline Child (Pass)

Child runbook that auto-passes. Used as an inline composition target for pass propagation scenarios.

## 1. Execute child task

- PASS COMPLETE
- FAIL STOP

```bash
rd echo --result pass "child task passed"
```
