# GOTO Static Named Substep

Demonstrates GOTO N.Name - jumping to a named substep within a static step.

## 1. Setup

### 1.1 Prepare
- PASS: GOTO 1.Cleanup
- FAIL: STOP

Initial preparation.

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

Main execution.

```bash
rd echo "execute main task"
```

