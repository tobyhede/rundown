---
name: stash-pop-interleave
description: Stash runbook A, run runbook B to completion, pop A and resume
tags:
  - stash-pop
scenarios:
  interleave:
    description: Stash A after step 1, run B to completion, pop A and complete
    commands:
      - rd run --prompted stash-pop-interleave.runbook.md
      - rd pass
      - rd stash
      - rd run stash-pop-interleave-child.runbook.md
      - rd pop
      - rd pass
    result: COMPLETE
---

# Stash Pop Interleave

Stash this runbook, run a different one to completion, then resume.

## 1. Start work

- PASS CONTINUE

```bash
rd echo "A: step one"
```

## 2. Finish work

- PASS COMPLETE

```bash
rd echo "A: step two"
```
