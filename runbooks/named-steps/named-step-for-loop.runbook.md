---
name: named-step-for-loop
description: FOR loop annotation on a named step
tags:
  - named-steps
scenarios:
  completed:
    description: Named step iterates normally with FOR loop
    commands:
      - rd run named-step-for-loop.runbook.md
    result: COMPLETE
---

# Named Step FOR Loop

## 1. Entry

- PASS GOTO Process

```bash
rd echo "entry"
```

## Process

- FOR item IN 1 TO 3
- PASS ALL COMPLETE
- FAIL ANY STOP

### Process.1 Handle {{item}}

```bash
rd echo "item={{item}}"
```
