---
name: list-instructions
description: Demonstrates steps with list-formatted instructions
tags:
  - features

scenarios:
  completed:
    description: List instructions are rendered correctly
    commands:
      - rd run --prompted list-instructions.runbook.md
      - rd pass
      - rd pass
    result: COMPLETE
---

# List Instructions

## 1. Step with list instructions
- PASS: CONTINUE
- FAIL: STOP

The following instructions should be preserved:
- instruction 1
- instruction 2

## 2. Step with mixed content
- PASS: COMPLETE
- FAIL: STOP

General prose.
- instruction 3
- instruction 4
