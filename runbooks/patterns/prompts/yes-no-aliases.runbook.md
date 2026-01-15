---
name: yes-no-aliases
description: Tests that YES/NO work as aliases for PASS/FAIL

scenarios:
  yes-path:
    description: User confirms with YES, workflow continues
    commands:
      - rd run --prompted yes-no-aliases.runbook.md
      - rd pass
    result: COMPLETE
  no-path:
    description: User declines with NO, workflow stops
    commands:
      - rd run --prompted yes-no-aliases.runbook.md
      - rd fail
    result: STOP
tags:
  - prompts
---

# YES/NO Aliases

Test that YES/NO work as aliases for PASS/FAIL.

## 1. Prompt step
- YES: CONTINUE
- NO: STOP "Verification failed"

Did you verify the deployment?
