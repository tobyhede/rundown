---
name: fail-continue-transition
description: Demonstrates FAIL leading to CONTINUE - proceed despite failure

scenarios:
  success-path:
    description: All steps pass including non-critical Execute
    commands:
      - rd run --prompted fail-continue-transition.runbook.md
      - rd pass
      - rd pass
      - rd pass
    result: COMPLETE
  fail-continue:
    description: Execute fails but workflow continues to Cleanup
    commands:
      - rd run --prompted fail-continue-transition.runbook.md
      - rd pass
      - rd fail
      - rd pass
    result: COMPLETE
---

# FAIL CONTINUE Transition

Demonstrates FAIL leading to CONTINUE - proceed despite failure.

## 1. Setup
- PASS: CONTINUE
- FAIL: STOP

Prepare the environment.

```bash
rd echo "setup environment"
```


## 2. Execute
- PASS: CONTINUE
- FAIL: CONTINUE

Non-critical step that may fail.

```bash
rd echo "execute non-critical task" --result fail
```


## 3. Cleanup
- PASS: COMPLETE
- FAIL: STOP

Always runs regardless of Execute result.

```bash
rd echo "cleanup resources"
```

