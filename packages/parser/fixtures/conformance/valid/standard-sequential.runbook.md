## 1. Setup

```bash
rd echo --result pass
```

- PASS: CONTINUE
- FAIL: STOP

## 2. Test

```bash
rd echo --result fail --result fail --result pass
```

- PASS: COMPLETE
- FAIL: RETRY 2
