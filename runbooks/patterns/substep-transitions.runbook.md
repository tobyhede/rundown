---
name: substep-transitions
description: Tests discrete transitions and navigation at the substep level, including conditional branching with GOTO and error handling with retries.

scenarios:
  happy-path:
    description: Tests successful completion through branch point
    commands:
      - rd run --prompted substep-transitions.runbook.md
      - rd pass
      - rd pass
      - rd pass
      - rd pass
    result: COMPLETE
  retry-on-failure:
    description: Tests retry behavior when initial step fails
    commands:
      - rd run --prompted substep-transitions.runbook.md
      - rd fail
      - rd pass
      - rd pass
      - rd pass
      - rd pass
    result: COMPLETE
  goto-branch:
    description: Tests GOTO transition to skip alternative path
    commands:
      - rd run --prompted substep-transitions.runbook.md
      - rd pass
      - rd pass
      - rd pass
      - rd pass
    result: COMPLETE
---

# Substep Transitions Conformance
Tests discrete transitions and navigation at the substep level.

## 1. Complex Parent

### 1.1 Initial
- PASS: CONTINUE
- FAIL: RETRY 2 STOP

Do first thing.
```bash
rd echo --result pass
```

### 1.2 Branch point
- YES: GOTO 1.4
- NO: CONTINUE

Ask a question.
```bash
rd echo --result pass
```

### 1.3 Alternative path
- PASS: CONTINUE

Should be skipped if YES.
```bash
rd echo --result pass
```

### 1.4 Target
- PASS: CONTINUE

Reached via GOTO or CONTINUE.
```bash
rd echo --result pass
```
