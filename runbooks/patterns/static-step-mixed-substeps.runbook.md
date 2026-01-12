# Static Step With Mixed Substeps

Demonstrates static steps containing both numbered and named substeps.

## 1. Setup

### 1.1 Prepare

Prepare the environment.

```bash
rd echo "prepare environment"
```

- PASS: CONTINUE
- FAIL: STOP

### 1.Cleanup

Named cleanup substep.

```bash
rd echo "cleanup resources"
```

- PASS: CONTINUE
- FAIL: STOP

## 2. Execute

Run the main task.

```bash
rd echo "execute main task"
```

- PASS: COMPLETE
- FAIL: GOTO 1.Cleanup
