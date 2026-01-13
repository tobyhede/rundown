# Named Step With Named Substeps

Demonstrates named steps containing named substeps.

## 1. Setup
Initial setup.

- PASS: CONTINUE
- FAIL: GOTO ErrorHandler

```bash
rd echo "initial setup"
```


## ErrorHandler

### ErrorHandler.Prepare
Prepare for error handling.

- PASS: GOTO ErrorHandler.Execute
- FAIL: STOP

```bash
rd echo "prepare error handling"
```


### ErrorHandler.Execute
Execute error recovery.

- PASS: GOTO ErrorHandler.Verify
- FAIL: STOP

```bash
rd echo "execute recovery"
```


### ErrorHandler.Verify
Verify recovery succeeded.

- PASS: GOTO 1
- FAIL: STOP

```bash
rd echo "verify recovery"
```

