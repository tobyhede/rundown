---
name: list-instructions
description: Demonstrates steps with list-formatted instructions

scenarios:
  success:
    description: Both steps with list instructions complete successfully
    commands:
      - rd run --prompted list-instructions.runbook.md
      - rd pass
      - rd pass
    result: COMPLETE
tags:
  - features
---

# List Instructions

## 1. Step with list instructions
The following instructions should be preserved:
- instruction 1
- instruction 2

## 2. Step with mixed content
General prose.
- instruction 3
- instruction 4
