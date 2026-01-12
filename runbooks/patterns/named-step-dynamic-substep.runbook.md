# Named Step With Dynamic Substep

Demonstrates a named step containing dynamic substeps.

## 1. Run

```bash
rd echo --result fail
```

- FAIL: GOTO ErrorHandler

## ErrorHandler

### ErrorHandler.{N}

```bash
rd echo --result fail --result pass
```

- PASS: COMPLETE
- FAIL: GOTO NEXT
