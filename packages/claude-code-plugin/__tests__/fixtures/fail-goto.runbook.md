## 1. First task

May fail and jump to recovery.

- PASS: CONTINUE
- FAIL: GOTO 3

## 2. Normal path

Skipped on failure.

- PASS: CONTINUE
- FAIL: STOP

## 3. Recovery task

Jumped here on failure.

- PASS: COMPLETE
- FAIL: STOP
