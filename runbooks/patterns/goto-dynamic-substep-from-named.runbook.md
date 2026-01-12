# GOTO Dynamic Substep From Named Step

Demonstrates GOTO {N}.M from a named step to a dynamic substep instance.

## 1. Setup

Initial setup.

```bash
rd echo "initial setup"
```

- PASS: CONTINUE
- FAIL: STOP

## 2. Process Batch

### 2.{n} Process Item

Process each item in the batch.

```bash
rd echo "process item"
```

- PASS: CONTINUE
- FAIL: GOTO ErrorHandler

### 2.Review

Review the batch results.

```bash
rd echo "review results"
```

- PASS: CONTINUE
- FAIL: GOTO ErrorHandler

## 3. Complete

```bash
rd echo "finalize completion"
```

- PASS: COMPLETE
- FAIL: STOP

## ErrorHandler

Handle errors and retry from batch processing.

```bash
rd echo "handle error"
```

- PASS: GOTO 2.{n}
- FAIL: STOP
