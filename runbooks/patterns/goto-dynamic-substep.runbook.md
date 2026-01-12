# GOTO Dynamic Substep
Demonstrates GOTO {N}.M - jumping within a dynamic step instance.

## {N}. Process batch

### {N}.1 First task

```bash
rd echo --result pass
```

- PASS: GOTO {N}.3
- FAIL: STOP

### {N}.2 Skipped task

This task is skipped via GOTO.

```bash
rd echo --result fail
```

- PASS: CONTINUE
- FAIL: STOP

### {N}.3 Final task

Reached via GOTO from {N}.1.

```bash
rd echo --result pass
```

- PASS: GOTO NEXT
- FAIL: STOP
