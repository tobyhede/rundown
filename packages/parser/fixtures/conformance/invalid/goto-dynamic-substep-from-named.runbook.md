# GOTO Dynamic Substep From Named Step

Demonstrates GOTO {N}.M from a named step to a dynamic substep instance.

## 1. Setup
- PASS: CONTINUE
- FAIL: STOP

Initial setup.

```bash
rd echo "initial setup"
```

## 2. Process Batch

### 2.{n} Process Item
- PASS: CONTINUE
- FAIL: GOTO ErrorHandler

Process each item in the batch.

```bash
rd echo "process item"
```

### 2.Review
- PASS: CONTINUE
- FAIL: GOTO ErrorHandler

Review the batch results.

```bash
rd echo "review results"
```

## 3. Complete
- PASS: COMPLETE
- FAIL: STOP

```bash
rd echo "finalize completion"
```

## ErrorHandler
- PASS: GOTO 2.{n}
- FAIL: STOP

Handle errors and retry from batch processing.

```bash
rd echo "handle error"
```
