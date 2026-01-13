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
This task is skipped via GOTO.

- PASS: CONTINUE
- FAIL: STOP

```bash
rd echo --result fail
```


### {N}.3 Final task
Reached via GOTO from {N}.1.

- PASS: GOTO NEXT
- FAIL: STOP

```bash
rd echo --result pass
```

