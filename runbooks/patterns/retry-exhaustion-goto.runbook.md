# RETRY Exhaustion with GOTO

Tests that RETRY exhaustion triggers GOTO fallback action.

## 1. Flaky step

```bash
rd echo --result fail --result fail --result fail
```

- PASS: CONTINUE
- FAIL: RETRY 2 GOTO 3

## 2. Skip

```bash
rd echo --result pass
```

- PASS: COMPLETE

## 3. Recovery step

```bash
rd echo --result pass
```

- PASS: COMPLETE
