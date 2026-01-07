# Retry Counter Reset on GOTO

Tests spec rule: "GOTO resets the retry counter to 0 for the target location"

## 1. First attempt

```bash
tsv echo --result fail --result fail
```

- PASS: CONTINUE
- FAIL: RETRY 1 GOTO 2

## 2. Second attempt (counter should be 0 again)

```bash
tsv echo --result fail --result pass
```

- PASS: COMPLETE
- FAIL: RETRY 1 STOP
