# Named Step With Mixed Substeps

Demonstrates named steps with both static and named substeps.

## 1. Setup
Initial setup.

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


### ErrorHandler.Cleanup
Named cleanup substep.

- PASS: GOTO 1
- FAIL: STOP

```bash
rd echo "cleanup after error"
```

