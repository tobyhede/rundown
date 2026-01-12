# Named Step With Static Substeps

Demonstrates named steps containing numbered substeps.

## 1. Setup

Initial setup step.

```bash
rd echo "initial setup"
```

- PASS: CONTINUE
- FAIL: GOTO ErrorHandler

## ErrorHandler

### ErrorHandler.1 Prepare

Prepare for error handling.

```bash
rd echo "prepare error handling"
```

- PASS: CONTINUE
- FAIL: STOP

### ErrorHandler.2 Execute

Execute error recovery.

```bash
rd echo "execute recovery"
```

- PASS: CONTINUE
- FAIL: STOP

### ErrorHandler.3 Verify

Verify recovery succeeded.

```bash
rd echo "verify recovery"
```

- PASS: GOTO 1
- FAIL: STOP
