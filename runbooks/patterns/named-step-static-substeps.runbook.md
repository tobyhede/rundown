# Named Step With Static Substeps

Demonstrates named steps containing numbered substeps.

## 1. Setup
- PASS: CONTINUE
- FAIL: GOTO ErrorHandler

Initial setup step.

```bash
rd echo "initial setup"
```


## ErrorHandler

### ErrorHandler.1 Prepare
- PASS: CONTINUE
- FAIL: STOP

Prepare for error handling.

```bash
rd echo "prepare error handling"
```


### ErrorHandler.2 Execute
- PASS: CONTINUE
- FAIL: STOP

Execute error recovery.

```bash
rd echo "execute recovery"
```


### ErrorHandler.3 Verify
- PASS: GOTO 1
- FAIL: STOP

Verify recovery succeeded.

```bash
rd echo "verify recovery"
```

