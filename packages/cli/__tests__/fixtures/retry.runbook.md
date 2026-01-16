## 1. Retry step

- PASS: CONTINUE
- FAIL: RETRY 3

May need multiple attempts.

```bash
rd echo --result fail --result fail --result pass
```

## 2. Final step

- PASS: COMPLETE
- FAIL: STOP

Complete runbook.

```bash
rd echo --result pass
```
