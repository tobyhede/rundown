---
name: standard-sequential
description: Sequential workflow with CONTINUE and RETRY transitions
tags:
  - sequential

scenarios:
  success-first-try:
    description: Both steps pass on first attempt
    commands:
      - rd run --prompted standard-sequential.runbook.md
      - rd pass
      - rd pass
    result: COMPLETE
  success-after-retry:
    description: Step 2 fails twice then passes (using retry)
    commands:
      - rd run --prompted standard-sequential.runbook.md
      - rd pass
      - rd fail
      - rd fail
      - rd pass
    result: COMPLETE
  auto-execution:
    description: Step 1 passes, step 2 fails twice then passes on retry
    commands:
      - rd run standard-sequential.runbook.md
    result: COMPLETE
---

## 1. Setup
- PASS: CONTINUE
- FAIL: STOP

```bash
rd echo --result pass
```


## 2. Test
- PASS: COMPLETE
- FAIL: RETRY 2

```bash
rd echo --result fail --result fail --result pass
```

