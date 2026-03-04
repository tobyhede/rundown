---
name: substep-pass-fail
description: Substep-level PASS/FAIL transitions with FAIL CONTINUE
tags:
  - substeps
  - transitions

scenarios:
  completed:
    description: Pass all substeps and final step
    commands:
      - rd run --prompted substep-pass-fail.runbook.md
      - rd pass
      - rd pass
      - rd pass
    result: COMPLETE
  fail-continues:
    description: Fail optional substep 1.2 but continue to step 2
    commands:
      - rd run --prompted substep-pass-fail.runbook.md
      - rd pass
      - rd fail
      - rd pass
    result: COMPLETE
---

# Substep Transitions

Substep-level PASS/FAIL transitions including FAIL CONTINUE.

## 1. Checks

### 1.1 Required check

- PASS CONTINUE
- FAIL STOP

```bash
rd echo "check"
```

### 1.2 Optional check

- PASS CONTINUE
- FAIL CONTINUE

```bash
rd echo "optional"
```

## 2. Finish

- PASS COMPLETE

```bash
rd echo "done"
```
