# Named Step With Named Substeps

Demonstrates named steps containing named substeps.

## 1. Setup

Initial setup.

```bash
rd echo "initial setup"
```

- PASS: CONTINUE
- FAIL: GOTO ErrorHandler

## ErrorHandler

### ErrorHandler.Prepare

Prepare for error handling.

```bash
rd echo "prepare error handling"
```

- PASS: GOTO ErrorHandler.Execute
- FAIL: STOP

### ErrorHandler.Execute

Execute error recovery.

```bash
rd echo "execute recovery"
```

- PASS: GOTO ErrorHandler.Verify
- FAIL: STOP

### ErrorHandler.Verify

Verify recovery succeeded.

```bash
rd echo "verify recovery"
```

- PASS: GOTO 1
- FAIL: STOP
