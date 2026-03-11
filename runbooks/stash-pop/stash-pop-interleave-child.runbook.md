---
name: stash-pop-interleave-child
description: Child runbook used during stash-pop interleave (auto-completes)
tags:
  - stash-pop
scenarios:
  auto_pass:
    description: Auto-executes and completes
    commands:
      - rd run stash-pop-interleave-child.runbook.md
    result: COMPLETE
---

# Interleave Child

Simple auto-completing runbook used as the interleaved task during stash-pop.

## 1. Quick task

- PASS COMPLETE

```bash
rd echo "B: done"
```
