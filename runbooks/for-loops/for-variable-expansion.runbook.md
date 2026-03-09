---
name: for-variable-expansion
description: FOR loop variable expansion in step descriptions and commands.
tags:
  - for-loops
scenarios:
  expanded:
    description: FOR loop variables expand across iterations
    commands:
      - rd run for-variable-expansion.runbook.md
    result: COMPLETE
---

# FOR Loop Variables

## 1. Process items

- FOR item IN 1 TO 3
- PASS ALL: CONTINUE

### 1.1 Handle item {{item}} index {{Index}}

```bash
rd echo item={{item}} index={{Index}}
```
