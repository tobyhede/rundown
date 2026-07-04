---
name: delegate-typed-inheritance
description: Delegation inherits typed runtime values without explicit child flags
tags:
  - delegation
  - variables
scenarios:
  completed:
    description: Child claim receives number, array, and object values from the parent context snapshot
    commands:
      - rd run delegate-typed-inheritance.runbook.md --input-json 'NumberValue=42' --input-json 'ArrayValue=["alpha","beta"]' --input-json 'ObjectValue={"count":2,"enabled":true}'
      - rd claim ${TOKEN}
      - rd collect --run ${RUN_ID}
    result: COMPLETE
---
# Delegate Typed Inheritance

## 1. Parent work
- PASS ALL COMPLETE
- FAIL ANY STOP

### 1.1 Child task

- DELEGATE
- delegate-typed-inheritance-child.runbook.md
