---
name: outputs-json-array-for
description: Captured JSON array OUTPUTS can drive a later FOR loop
tags:
  - context-passing
  - for-loops
scenarios:
  completed:
    description: Step OUTPUTS captures an array and the next step iterates it
    commands:
      - rd run --allow-all --input-json 'Items=[]' outputs-json-array-for.runbook.md
    result: COMPLETE
---
# OUTPUTS JSON Array FOR

## 1. Capture items
- OUTPUTS
  - Items
- PASS CONTINUE
- FAIL STOP

```sh
printf '["left","right"]' > "$RD_OUTPUTS_Items"
```

## 2. Assert captured items
- FOR item IN {{ Items }}
- PASS ALL COMPLETE
- FAIL ANY STOP

### 2.1 Check item
- PASS CONTINUE
- FAIL STOP

```sh
rd echo "{{ Index }}:{{ item }}"
```
