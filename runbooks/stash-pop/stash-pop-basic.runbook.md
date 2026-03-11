---
name: stash-pop-basic
description: Stash mid-execution and resume with pop
tags:
  - stash-pop
scenarios:
  stash-and-resume:
    description: Stash after step 1, pop to resume at step 2, then complete
    commands:
      - rd run --prompted stash-pop-basic.runbook.md
      - rd pass
      - rd stash
      - rd pop
      - rd pass
    result: COMPLETE
---

# Stash Pop Basic

Demonstrates stashing a runbook mid-execution and resuming with pop.

## 1. Initial work

- PASS CONTINUE

```bash
rd echo "step one"
```

## 2. Final work

- PASS COMPLETE

```bash
rd echo "step two"
```
