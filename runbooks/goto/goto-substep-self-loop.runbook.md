---
name: goto-substep-self-loop
description: GOTO to the same substep creates a retry loop until pass completes it
tags:
  - goto
  - loop

scenarios:
  completed:
    description: Pass immediately completes (default CONTINUE, last substep)
    commands:
      - rd run --prompted goto-substep-self-loop.runbook.md
      - rd pass --token ${TOKEN} --step 1.1
    result: COMPLETE

  looped:
    description: Fail loops back twice, then pass completes
    commands:
      - rd run --prompted goto-substep-self-loop.runbook.md
      - rd fail --token ${TOKEN} --step 1.1
      - rd fail --token ${TOKEN} --step 1.1
      - rd pass --token ${TOKEN} --step 1.1
    result: COMPLETE
---

# Substep Self-Loop

GOTO to the same substep creates a retry loop until pass completes it.

## 1. Test step

### 1.1 First substep

- FAIL GOTO 1.1
