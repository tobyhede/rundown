# Named Step With Static Substeps

Demonstrates named steps containing numbered substeps.

## 1. Setup
Initial setup step.

- PASS: CONTINUE
- FAIL: GOTO ErrorHandler

```bash
rd echo "initial setup"
```


## ErrorHandler

### ErrorHandler.1 Prepare
Prepare for error handling.

- PASS: CONTINUE
- FAIL: STOP

```bash
rd echo "prepare error handling"
```


### ErrorHandler.2 Execute
Execute error recovery.

- PASS: CONTINUE
- FAIL: STOP

```bash
rd echo "execute recovery"
```


### ErrorHandler.3 Verify
Verify recovery succeeded.

- PASS: GOTO 1
- FAIL: STOP

```bash
rd echo "verify recovery"
```

