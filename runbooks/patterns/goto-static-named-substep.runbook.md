# GOTO Static Named Substep

Demonstrates GOTO N.Name - jumping to a named substep within a static step.

## 1. Setup

### 1.1 Prepare

Initial preparation.

```bash
rd echo "prepare environment"
```

- PASS: GOTO 1.Cleanup
- FAIL: STOP

### 1.Cleanup

Named cleanup substep.

```bash
rd echo "cleanup resources"
```

- PASS: CONTINUE
- FAIL: STOP

## 2. Execute

Main execution.

```bash
rd echo "execute main task"
```

- PASS: COMPLETE
- FAIL: GOTO 1.Cleanup
