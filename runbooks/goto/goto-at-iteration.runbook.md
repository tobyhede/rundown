---
name: goto-at-iteration
description: GOTO AT jumps into a FOR loop at a specific iteration
tags:
  - goto
scenarios:
  completed:
    description: Step 1 passes and jumps to FOR step 2 at iteration 3
    commands:
      - rd run goto-at-iteration.runbook.md
    result: COMPLETE
---

# GOTO AT Iteration

## 1. Entry

- PASS: GOTO 2 AT 3

Check passes and jumps to step 2 at iteration 3.

```bash
rd echo "entry"
```

## 2. Process items

- FOR item IN 1 TO 5
- PASS ALL: COMPLETE

### 2.1 Handle {{item}}

```bash
rd echo "item={{item}}"
```
