# GOTO {N} - Restart Dynamic Instance

Demonstrates restarting the current dynamic step from the beginning.

## {N}. Process Item

### {N}.1 Setup
- PASS: CONTINUE

```bash
rd echo --result pass
```


### {N}.2 Execute
- PASS: GOTO NEXT
- FAIL: GOTO {N}

```bash
rd echo --result pass --result fail
```

