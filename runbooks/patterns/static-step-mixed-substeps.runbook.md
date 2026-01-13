# Static Step With Mixed Substeps

Demonstrates static steps containing both numbered and named substeps.

## 1. Setup

### 1.1 Prepare
Prepare the environment.

- PASS: CONTINUE
- FAIL: STOP

```bash
rd echo "prepare environment"
```


### 1.Cleanup
Named cleanup substep.

- PASS: CONTINUE
- FAIL: STOP

```bash
rd echo "cleanup resources"
```


## 2. Execute
Run the main task.

- PASS: COMPLETE
- FAIL: GOTO 1.Cleanup

```bash
rd echo "execute main task"
```

