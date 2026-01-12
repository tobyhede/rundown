# FAIL COMPLETE Transition

Demonstrates FAIL leading to COMPLETE - workflow completes on failure.

## 1. Setup

Prepare the environment.

```bash
rd echo "setup environment"
```

- PASS: CONTINUE
- FAIL: STOP

## 2. Execute

Check for early exit condition.

```bash
rd echo "check exit condition" --result fail
```

- PASS: CONTINUE
- FAIL: COMPLETE "Early exit condition met"

## 3. Cleanup

Only runs if Execute passed.

```bash
rd echo "cleanup after success"
```

- PASS: COMPLETE
- FAIL: STOP
