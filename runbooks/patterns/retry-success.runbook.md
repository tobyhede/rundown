# RETRY Success Before Exhaustion

Tests that RETRY succeeds before count is exhausted.

## 1. Flaky step that recovers
- PASS: COMPLETE
- FAIL: RETRY 3 STOP

```bash
rd echo --result fail --result pass
```

