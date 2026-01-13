# Substep Transitions Conformance
Tests discrete transitions and navigation at the substep level.

## 1. Complex Parent

### 1.1 Initial
Do first thing.
- PASS: CONTINUE
- FAIL: RETRY 2 STOP

```bash
rd echo --result pass
```

### 1.2 Branch point
Ask a question.
- YES: GOTO 1.4
- NO: CONTINUE

```bash
rd echo --result pass
```

### 1.3 Alternative path
Should be skipped if YES.
- PASS: CONTINUE

```bash
rd echo --result pass
```

### 1.4 Target
Reached via GOTO or CONTINUE.
- PASS: CONTINUE

```bash
rd echo --result pass
```
