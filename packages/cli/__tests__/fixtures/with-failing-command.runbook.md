## 1. Execute failing command

- PASS: CONTINUE
- FAIL: RETRY 2

Run a command that fails then succeeds.

```bash
rd echo --result fail --result fail --result pass
```

## 2. Complete step

- PASS: COMPLETE
- FAIL: STOP

```bash
rd echo --result pass
```
