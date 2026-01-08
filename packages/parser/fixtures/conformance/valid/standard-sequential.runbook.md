## 1. Setup

```bash
tsv echo --result pass
```

- PASS: CONTINUE
- FAIL: STOP

## 2. Test

```bash
tsv echo --result fail --result fail --result pass
```

- PASS: COMPLETE
- FAIL: RETRY 2
