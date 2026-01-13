# Static Step With Mixed Substeps

Demonstrates static steps containing both numbered and named substeps.

## 1. Setup

### 1.1 Prepare
- PASS: CONTINUE
- FAIL: STOP

Prepare the environment.

```bash
rd echo "prepare environment"
```


### 1.Cleanup
- PASS: CONTINUE
- FAIL: STOP

Named cleanup substep.

```bash
rd echo "cleanup resources"
```


## 2. Execute
- PASS: COMPLETE
- FAIL: GOTO 1.Cleanup

Run the main task.

```bash
rd echo "execute main task"
```

