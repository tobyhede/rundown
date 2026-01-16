---
name: mixed-prompts
description: Step with both explicit Prompt and implicit instruction list

scenarios:
  completed:
    description: All prompt types pass successfully
    commands:
      - rd run --prompted mixed-prompts.runbook.md
      - rd pass
      - rd pass
      - rd pass
      - rd pass
    result: COMPLETE
tags:
  - prompts
  - mixed
---

# Mixed Prompt Types

## 1. Mixed prompts
- PASS: CONTINUE
- FAIL: STOP


**Prompt:** Explicit prompt.
- Implicit instruction 1
- Implicit instruction 2

