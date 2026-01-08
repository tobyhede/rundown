## 1. Main step

Has substeps.

### 1.1. Substep A

First substep.

```bash
rd echo --result pass
```

- PASS: CONTINUE

### 1.2. Substep B

Second substep.

```bash
rd echo --result fail --result pass
```

- PASS: CONTINUE
- FAIL: RETRY 2

## 2. Complete

Done.

```bash
rd echo --result pass
```

- PASS: COMPLETE
- FAIL: STOP
