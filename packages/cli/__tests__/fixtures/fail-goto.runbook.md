## 1. First step

May fail and jump to recovery.

```bash
rd echo --result fail
```

- PASS: CONTINUE
- FAIL: GOTO 3

## 2. Normal path

Skipped on failure.

```bash
rd echo --result pass
```

- PASS: CONTINUE
- FAIL: STOP

## 3. Recovery step

Jumped here on failure.

```bash
rd echo --result pass
```

- PASS: COMPLETE
- FAIL: STOP
