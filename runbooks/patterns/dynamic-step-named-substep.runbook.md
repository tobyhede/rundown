# Dynamic Step With Named Substep

## {N}. Dynamic

### {N}.1 Substep 1
- PASS: GOTO {N}.Named


```bash
rd echo --result pass
```

### {N}.2 Substep 2
Substep 2 should be skipped
```bash
rd echo --result fail
```

### {N}.Named Substep with Name
- PASS: COMPLETE


```bash
rd echo --result pass
```
