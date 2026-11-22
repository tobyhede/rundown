---
name: delegation-child-pass
description: Delegation target that completes on its own when claimed, and reports an output
tags:
  - delegation
outputs:
  - Verdict "approved"

scenarios:
  completed:
    description: Run standalone, the child executes its command and completes
    commands:
      - rd run delegation-child-pass.runbook.md
    result: COMPLETE
---

# Delegation Child (Pass)

Delegation target. Claimed by `rundown claim`, its Run Progression runs the
command and completes at once; its frontmatter `outputs` flow to the parent
when the parent Collects it.

## 1. Execute child task

- PASS COMPLETE
- FAIL STOP

```bash
rd echo "child task completed"
```
