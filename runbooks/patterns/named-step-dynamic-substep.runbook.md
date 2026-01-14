---
name: named-step-dynamic-substep
description: Demonstrates a named step containing dynamic substeps that execute until a pass condition is met.

scenarios:
  pass-on-second-attempt:
    description: Tests dynamic substeps, failing on first attempt then passing on second attempt
    commands:
      - rd run --prompted named-step-dynamic-substep.runbook.md
      - rd fail
      - rd pass
    result: COMPLETE
---

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


