# GOTO Static Named Substep

Demonstrates GOTO N.Name - jumping to a named substep within a static step.

## 1. Setup

### 1.1 Prepare
Initial preparation.

- PASS: GOTO 1.Cleanup
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
Main execution.

- PASS: COMPLETE
- FAIL: GOTO 1.Cleanup

```bash
rd echo "execute main task"
```

