# Mixed Static And Named With Error Handler

Demonstrates static steps with a named error handler step.

## 1. Setup

Prepare the environment.

```bash
rd echo "setup environment"
```

- PASS: CONTINUE
- FAIL: GOTO ErrorHandler

## 2. Execute

Execute the main task.

```bash
rd echo "execute task"
```

- PASS: CONTINUE
- FAIL: GOTO ErrorHandler

## 3. Cleanup

Final cleanup.

```bash
rd echo "cleanup resources"
```

- PASS: COMPLETE
- FAIL: GOTO ErrorHandler

## ErrorHandler

Central error handling step.

```bash
rd echo "handle error"
```

- PASS: GOTO 1
- FAIL: STOP "Unrecoverable error"
