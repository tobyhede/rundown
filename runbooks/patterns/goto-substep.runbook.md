# GOTO Substep
Demonstrates GOTO N.M - jumping to a specific substep.

## 1. Parent step

### 1.1 Setup
- PASS: GOTO 1.3
- FAIL: STOP

```bash
rd echo --result pass
```


### 1.2 Skipped


### 1.3 GOTO Target

Reached via GOTO from 1.1.

```bash
rd echo --result pass
```
