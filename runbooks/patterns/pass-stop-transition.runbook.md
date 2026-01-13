# PASS STOP Transition

Demonstrates PASS leading to STOP - workflow halts on success.

## 1. Setup
- PASS: CONTINUE
- FAIL: STOP

Prepare the environment.

```bash
rd echo "setup environment"
```


## 2. Execute
- PASS: STOP "Check passed, halting workflow"
- FAIL: CONTINUE

Execute the critical check.

```bash
rd echo "critical check"
```


## 3. Cleanup
- PASS: COMPLETE
- FAIL: STOP

This step only runs if Execute failed.

```bash
rd echo "cleanup resources"
```

