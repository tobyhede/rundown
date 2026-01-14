---
name: goto-next
description: Demonstrates GOTO NEXT - advancing to the next dynamic step instance

scenarios:
  single-iteration:
    description: First iteration passes, advances to next, then fails to complete
    commands:
      - rd run --prompted goto-next.runbook.md
      - rd pass
      - rd fail
    result: COMPLETE
  multiple-iterations:
    description: Two iterations pass before failing to complete
    commands:
      - rd run --prompted goto-next.runbook.md
      - rd pass
      - rd pass
      - rd fail
    result: COMPLETE
---

# GOTO NEXT
Demonstrates GOTO NEXT - advancing to the next dynamic step instance.

## {N}. Iteration
- PASS: GOTO NEXT
- FAIL: COMPLETE

Process item N. Use COMPLETE to exit loop.

```bash
rd echo --result pass
```

