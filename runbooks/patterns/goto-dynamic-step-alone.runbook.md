# GOTO Dynamic Step (Infinite Retry)

Demonstrates infinite retry pattern. The step restarts on PASS and only
exits on FAIL (defaults to STOP). Use for operations that should retry
indefinitely until an external condition causes failure.

## {N}. Dynamic
```bash
rd echo --result pass --result pass --result pass --result pass --result fail
```
- PASS: GOTO {N}
