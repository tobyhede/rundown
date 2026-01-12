# Retry Exhaustion COMPLETE

Demonstrates RETRY with COMPLETE on exhaustion.

## 1. Setup

Prepare the environment.

```bash
rd echo "setup environment"
```

- PASS: CONTINUE
- FAIL: STOP

## 2. Execute

Retry up to 3 times, then complete successfully.

```bash
rd echo "retry operation" --result fail --result fail --result pass
```

- PASS: CONTINUE
- FAIL: RETRY 3 COMPLETE "Max retries reached, completing anyway"

## 3. Cleanup

Final cleanup.

```bash
rd echo "cleanup resources"
```

- PASS: COMPLETE
- FAIL: STOP
