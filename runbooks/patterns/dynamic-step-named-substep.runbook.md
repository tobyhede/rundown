# Dynamic Step With Named Substep

## {N}. Dynamic

### {N}.1 Substep 1
```bash
rd echo --result pass
```
- PASS: GOTO {N}.Named

### {N}.2 Substep 2
Substep 2 should be skipped
```bash
rd echo --result fail
```

### {N}.Named Substep with Name
```bash
rd echo --result pass
```
- PASS: COMPLETE
