# RETRY Exhaustion with CONTINUE

Tests that RETRY exhaustion triggers CONTINUE fallback action.

## 1. Flaky step

```bash
rd echo --result fail --result fail
```

- PASS: COMPLETE
- FAIL: RETRY 1 CONTINUE

## 2. Fallback step

```bash
rd echo --result pass
```

- PASS: COMPLETE
