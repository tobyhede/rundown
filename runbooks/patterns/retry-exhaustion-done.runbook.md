# RETRY Exhaustion with COMPLETE

Tests that RETRY exhaustion triggers COMPLETE fallback action.

## 1. Flaky step

```bash
rd echo --result fail --result fail
```

- PASS: CONTINUE
- FAIL: RETRY 1 COMPLETE
