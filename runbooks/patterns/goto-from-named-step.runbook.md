# GOTO From Named Step

Demonstrates navigation from a named step to a numbered step.

## 1. Setup
- PASS: CONTINUE
- FAIL: GOTO ErrorHandler

Initial setup.

```bash
rd echo "initial setup"
```


## 2. Execute
- PASS: COMPLETE
- FAIL: GOTO ErrorHandler

Main execution.

```bash
rd echo "main execution"
```


## ErrorHandler
- PASS: GOTO 1
- FAIL: STOP

Handle errors and retry.

```bash
rd echo "handle error"
```

