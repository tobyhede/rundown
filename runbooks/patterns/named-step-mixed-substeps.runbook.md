# Named Step With Mixed Substeps

Demonstrates named steps with both static and named substeps.

## 1. Setup

Initial setup.

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

### ErrorHandler.Cleanup

Named cleanup substep.

```bash
rd echo "cleanup after error"
```

- PASS: GOTO 1
- FAIL: STOP
