# RETRY Exhaustion with COMPLETE

Tests that RETRY exhaustion triggers COMPLETE fallback action.

## 1. Flaky step
- PASS: CONTINUE
- FAIL: RETRY 1 COMPLETE

```bash
rd echo --result fail --result fail
```

