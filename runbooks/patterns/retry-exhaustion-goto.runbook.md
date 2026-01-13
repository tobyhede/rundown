# RETRY Exhaustion with GOTO

Tests that RETRY exhaustion triggers GOTO fallback action.

## 1. Flaky step
- PASS: CONTINUE
- FAIL: RETRY 2 GOTO 3

```bash
rd echo --result fail --result fail --result fail
```


## 2. Skip
- PASS: COMPLETE

```bash
rd echo --result pass
```


## 3. Recovery step
- PASS: COMPLETE

```bash
rd echo --result pass
```

