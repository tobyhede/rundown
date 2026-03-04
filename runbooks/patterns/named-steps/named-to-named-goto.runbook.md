---
name: named-to-named-goto
description: GOTO between two named steps, skipping an intermediate step
tags:
  - named-steps
  - goto

scenarios:
  completed:
    description: Pass Setup (GOTO Finish), pass Finish
    commands:
      - rd run --prompted named-to-named-goto.runbook.md
      - rd pass
      - rd pass
    result: COMPLETE
---

# Named-to-Named GOTO

GOTO from named step Setup to named step Finish, skipping Middle.

## Setup

- PASS GOTO Finish
- FAIL STOP

```bash
rd echo "setup"
```

## Middle

- PASS CONTINUE

This step should be skipped.

```bash
rd echo --result fail
```

## Finish

- PASS COMPLETE

```bash
rd echo "finish"
```
