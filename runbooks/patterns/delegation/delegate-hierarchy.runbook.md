---
name: delegate-hierarchy
description: Grandparent to parent to child delegation chain
tags:
  - delegation

scenarios:
  completed:
    description: Pass all three levels of delegation
    commands:
      - rd run --prompted delegate-hierarchy.runbook.md
      - rd pass
      - rd pass
      - rd pass
    result: COMPLETE
---

# Delegation Hierarchy

Grandparent to parent to child delegation chain.

## 1. Level 1 (grandparent)

- PASS: CONTINUE
- FAIL: STOP

```bash
rd echo "level 1"
```

## 2. Level 2 (parent)

- PASS: CONTINUE
- FAIL: STOP

```bash
rd echo "level 2"
```

## 3. Level 3 (child completes)

- PASS: COMPLETE

```bash
rd echo "level 3"
```
