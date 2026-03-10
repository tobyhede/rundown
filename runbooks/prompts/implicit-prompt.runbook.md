---
name: implicit-prompt
description: Plain body text as implicit prompt without Prompt prefix
tags:
  - prompts

scenarios:
  completed:
    description: Pass both implicit prompt steps
    commands:
      - rd run --prompted implicit-prompt.runbook.md
      - rd pass
      - rd pass
    result: COMPLETE
---

# Implicit Prompts

Plain body text serves as an implicit prompt.

## 1. Review deployment

- PASS: CONTINUE
- FAIL: STOP

Review the deployment configuration.

## 2. Confirm changes

- PASS: COMPLETE

Confirm the changes are correct.
