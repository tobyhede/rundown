# GOTO NEXT X.{n} - Explicit Substep Advancement

Demonstrates explicitly advancing dynamic substep.

## 1. Static Step with Dynamic Substeps

### 1.{n} Process Item

```bash
rd echo --result pass --result fail
```

- PASS: GOTO NEXT 1.{n}
- FAIL: STOP
