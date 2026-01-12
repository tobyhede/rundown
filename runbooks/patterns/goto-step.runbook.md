# GOTO Step
Demonstrates GOTO N - jumping to a specific step number.

## 1. Setup

```bash
rd echo --result pass
```

- PASS: GOTO 3
- FAIL: STOP

## 2. Skip

This step is skipped via GOTO.

```bash
rd echo --result fail
```

- PASS: CONTINUE
- FAIL: STOP

## 3. Jump target

Reached via GOTO from step 1.

```bash
rd echo --result pass
```

- PASS: COMPLETE
- FAIL: STOP
