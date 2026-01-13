# FAIL COMPLETE Transition

Demonstrates FAIL leading to COMPLETE - workflow completes on failure.

## 1. Setup
- PASS: CONTINUE
- FAIL: STOP

Prepare the environment.

```bash
rd echo "setup environment"
```


## 2. Execute
- PASS: CONTINUE
- FAIL: COMPLETE "Early exit condition met"

Check for early exit condition.

```bash
rd echo "check exit condition" --result fail
```


## 3. Cleanup
- PASS: COMPLETE
- FAIL: STOP

Only runs if Execute passed.

```bash
rd echo "cleanup after success"
```

