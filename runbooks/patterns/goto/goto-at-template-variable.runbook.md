---
name: goto-at-template-variable
description: GOTO AT with template variable re-enters FOR step at current iteration
tags:
  - goto
scenarios:
  completed:
    description: GOTO AT re-enters the FOR step at the current iteration index
    commands:
      - rd run --prompted goto-at-template-variable.runbook.md
      - rd fail
      - rd pass
    result: COMPLETE
---

# GOTO AT Template Variable

## 1. Process

- FOR item IN 1 TO 3
- PASS ALL: COMPLETE

### 1.1 Handle {{item}}

- PASS: CONTINUE
- FAIL: GOTO 1 AT {{Index}}

```bash
rd echo "item={{item}}"
```
