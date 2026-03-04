---
name: delegation-child-pass
description: Simple child runbook that auto-completes (delegation target)
tags:
  - delegation

scenarios:
  auto-pass:
    description: Child auto-executes and completes
    commands:
      - rd run delegation-child-pass.runbook.md
    result: COMPLETE
---

# Delegation Child (Pass)

Simple child runbook used as a delegation target. Auto-completes on execution.

## 1. Execute child task

- PASS: COMPLETE
- FAIL: STOP

```bash
rd echo "child task completed"
```
