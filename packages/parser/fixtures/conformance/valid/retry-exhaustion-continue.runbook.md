# RETRY Exhaustion with CONTINUE

Tests that RETRY exhaustion triggers CONTINUE fallback action.

## 1. Flaky step

```bash
tsv echo --result fail --result fail
```

- PASS: COMPLETE
- FAIL: RETRY 1 CONTINUE

## 2. Fallback step

```bash
tsv echo --result pass
```

- PASS: COMPLETE
