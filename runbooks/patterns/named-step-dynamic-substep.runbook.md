# Named Step With Dynamic Substep

Demonstrates a named step containing dynamic substeps.

## 1. Run
- FAIL: GOTO ErrorHandler

```bash
rd echo --result fail
```


## ErrorHandler

### ErrorHandler.{n}
- PASS: COMPLETE
- FAIL: GOTO NEXT

```bash
rd echo --result fail --result pass
```


