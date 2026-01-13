## 1. Setup
- PASS: CONTINUE
- FAIL: STOP

```bash
rd echo --result pass
```


## 2. Test
- PASS: COMPLETE
- FAIL: RETRY 2

```bash
rd echo --result fail --result fail --result pass
```

