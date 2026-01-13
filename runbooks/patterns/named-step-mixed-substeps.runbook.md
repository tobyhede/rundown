# Named Step With Mixed Substeps

Demonstrates named steps with both static and named substeps.

## 1. Setup
- PASS: CONTINUE
- FAIL: GOTO ErrorHandler

Initial setup.

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


### ErrorHandler.Cleanup
- PASS: GOTO 1
- FAIL: STOP

Named cleanup substep.

```bash
rd echo "cleanup after error"
```

