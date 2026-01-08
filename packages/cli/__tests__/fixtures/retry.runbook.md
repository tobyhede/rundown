## 1. Retry step

May need multiple attempts.

```bash
rd echo --result fail --result fail --result pass
```

- PASS: CONTINUE
- FAIL: RETRY 3

## 2. Final step

Complete workflow.

```bash
rd echo --result pass
```

- PASS: COMPLETE
- FAIL: STOP
