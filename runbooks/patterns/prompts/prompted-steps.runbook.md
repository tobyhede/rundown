---
name: prompted-steps
description: Steps with explicit and implicit prompt definitions

scenarios:
  completed:
    description: All steps pass successfully
    commands:
      - rd run --prompted prompted-steps.runbook.md
      - rd pass
      - rd pass
    result: COMPLETE
tags:
  - prompts
---

## 1. Step with prompt
**Prompt:** Please review the code.

## 2. Step with implicit prompt
Review this instead.
