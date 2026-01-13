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
