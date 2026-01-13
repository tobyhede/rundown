## 1. Main step

Has substeps.

### 1.1. Substep A

- PASS: CONTINUE

First substep.

```bash
rd echo --result pass
```

### 1.2. Substep B

- PASS: CONTINUE
- FAIL: RETRY 2

Second substep.

```bash
rd echo --result fail --result pass
```

## 2. Complete

- PASS: COMPLETE
- FAIL: STOP

Done.

```bash
rd echo --result pass
```
