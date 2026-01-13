# RETRY Exhaustion with CONTINUE

Tests that RETRY exhaustion triggers CONTINUE fallback action.

## 1. Flaky step
- PASS: COMPLETE
- FAIL: RETRY 1 CONTINUE

```bash
rd echo --result fail --result fail
```


## 2. Fallback step
- PASS: COMPLETE

```bash
rd echo --result pass
```

