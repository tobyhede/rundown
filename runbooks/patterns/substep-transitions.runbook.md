# Substep Transitions Conformance
Tests discrete transitions and navigation at the substep level.

## 1. Complex Parent

### 1.1 Initial
- PASS: CONTINUE
- FAIL: RETRY 2 STOP

```bash
rd echo --result pass
```

Do first thing.

### 1.2 Branch point

```bash
rd echo --result pass
```

Ask a question.
- YES: GOTO 1.4
- NO: CONTINUE

### 1.3 Alternative path
- PASS: CONTINUE

```bash
rd echo --result pass
```

Should be skipped if YES.

### 1.4 Target
- PASS: CONTINUE

```bash
rd echo --result pass
```

Reached via GOTO or CONTINUE.
