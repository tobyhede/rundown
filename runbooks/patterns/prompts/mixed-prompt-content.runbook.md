---
name: mixed-prompt-content
description: Step with both explicit Prompt and implicit instruction list
tags:
  - prompts
  - mixed

scenarios:
  completed:
    description: All prompt types pass successfully
    commands:
      - rd run --prompted mixed-prompt-content.runbook.md
      - rd pass
      - rd pass
      - rd pass
      - rd pass
    result: COMPLETE
---

# Mixed Prompt Types

## 1. Mixed prompts

- PASS: CONTINUE
- FAIL: STOP

**Prompt:** Explicit prompt.

- Implicit instruction 1
- Implicit instruction 2
