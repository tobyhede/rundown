# GOTO {N} - Restart Dynamic Instance

Demonstrates restarting the current dynamic step from the beginning.

## {N}. Process Item

### {N}.1 Setup

```bash
rd echo --result pass
```

- PASS: CONTINUE

### {N}.2 Execute

```bash
rd echo --result pass --result fail
```

- PASS: GOTO NEXT
- FAIL: GOTO {N}
