---
name: iterate-and-delegate
description: Extract a work list, then delegate one worker per item.
tags:
  - patterns
---

# Iterate and Delegate

## 1. Extract items
- OUTPUTS
  - Items
- PASS CONTINUE
- FAIL STOP

```sh
printf '["left","right"]' > "$RD_OUTPUTS_Items"
```

## 2. Process each item
- FOR item IN {{ Items }}
  - PASS DEFER
  - FAIL BREAK
- DELEGATE
- PASS ALL COMPLETE
- FAIL ANY STOP

- process-one-item.runbook.md
