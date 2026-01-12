# PASS STOP Transition

Demonstrates PASS leading to STOP - workflow halts on success.

## 1. Setup

Prepare the environment.

```bash
rd echo "setup environment"
```

- PASS: CONTINUE
- FAIL: STOP

## 2. Execute

Execute the critical check.

```bash
rd echo "critical check"
```

- PASS: STOP "Check passed, halting workflow"
- FAIL: CONTINUE

## 3. Cleanup

This step only runs if Execute failed.

```bash
rd echo "cleanup resources"
```

- PASS: COMPLETE
- FAIL: STOP
