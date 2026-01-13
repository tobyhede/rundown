# Mixed Static And Named With Error Handler

Demonstrates static steps with a named error handler step.

## 1. Setup
- PASS: CONTINUE
- FAIL: GOTO ErrorHandler

Prepare the environment.

```bash
rd echo "setup environment"
```


## 2. Execute
- PASS: CONTINUE
- FAIL: GOTO ErrorHandler

Execute the main task.

```bash
rd echo "execute task"
```


## 3. Cleanup
- PASS: COMPLETE
- FAIL: GOTO ErrorHandler

Final cleanup.

```bash
rd echo "cleanup resources"
```


## ErrorHandler
- PASS: GOTO 1
- FAIL: STOP "Unrecoverable error"

Central error handling step.

```bash
rd echo "handle error"
```

