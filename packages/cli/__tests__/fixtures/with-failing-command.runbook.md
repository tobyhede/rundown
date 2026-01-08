## 1. Execute failing command

Run a command that fails then succeeds.

```bash
rd echo --result fail --result fail --result pass
```

- PASS: CONTINUE
- FAIL: RETRY 2

## 2. Complete step

```bash
rd echo --result pass
```

- PASS: COMPLETE
- FAIL: STOP
