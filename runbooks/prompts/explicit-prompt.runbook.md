---
name: explicit-prompt
description: Steps with explicit Prompt prefix
tags:
  - prompts

scenarios:
  completed:
    description: All steps pass successfully
    commands:
      - rd run --prompted explicit-prompt.runbook.md
      - rd pass --token ${TOKEN} --step 1
      - rd pass --token ${TOKEN} --step 2
    result: COMPLETE
---

## 1. Step with prompt

**Prompt:** Please review the code.

## 2. Step with implicit prompt

Review this instead.
