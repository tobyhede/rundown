---
name: list-instructions
description: Demonstrates steps with list-formatted instructions

scenarios:
  completed:
    description: List instructions are rendered correctly
    commands:
      - rd run --prompted list-instructions.runbook.md
      - rd pass
    result: COMPLETE
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
