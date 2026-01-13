# GOTO Dynamic Substep
Demonstrates GOTO {N}.M - jumping within a dynamic step instance.

## {N}. Process batch

### {N}.1 First task
- PASS: GOTO {N}.3
- FAIL: STOP

```bash
rd echo --result pass
```


### {N}.2 Skipped task
- PASS: CONTINUE
- FAIL: STOP

This task is skipped via GOTO.

```bash
rd echo --result fail
```


### {N}.3 Final task
- PASS: GOTO NEXT
- FAIL: STOP

Reached via GOTO from {N}.1.

```bash
rd echo --result pass
```

