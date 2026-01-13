## 1. First step

- PASS: CONTINUE
- FAIL: GOTO 3

May fail and jump to recovery.

```bash
rd echo --result fail
```

## 2. Normal path

- PASS: CONTINUE
- FAIL: STOP

Skipped on failure.

```bash
rd echo --result pass
```

## 3. Recovery step

- PASS: COMPLETE
- FAIL: STOP

Jumped here on failure.

```bash
rd echo --result pass
```
