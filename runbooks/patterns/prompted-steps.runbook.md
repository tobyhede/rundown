---
name: prompted-steps
description: Steps with explicit and implicit prompt definitions

scenarios:
  success:
    description: Both prompted steps complete successfully
    commands:
      - rd run --prompted prompted-steps.runbook.md
      - rd pass
      - rd pass
    result: COMPLETE
---

## 1. Step with prompt
**Prompt:** Please review the code.

## 2. Step with implicit prompt
Review this instead.
