---
name: delegate-typed-inheritance-child
inputs:
  - NumberValue
  - ArrayValue
  - ObjectValue
scenarios:
  direct-completed:
    description: Direct run verifies typed values with explicit inputs
    commands:
      - rd run delegate-typed-inheritance-child.runbook.md --input-json 'NumberValue=42' --input-json 'ArrayValue=["alpha","beta"]' --input-json 'ObjectValue={"count":2,"enabled":true}'
    result: COMPLETE
---
# Delegate Typed Inheritance Child

## 1. Verify inherited values
- PASS COMPLETE
- FAIL STOP

```sh
rd echo "number={{ NumberValue }} array={{ ArrayValue.0 }},{{ ArrayValue.1 }} object={{ ObjectValue.count }} enabled={{ ObjectValue.enabled }}"
```
