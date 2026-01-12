# Dynamic Step With Dynamic Substeps

Demonstrates doubly-dynamic iteration with {N}.{n} pattern.

## {N}. Process Batch

### {N}.{n} Process Item

Process each item in batch N.

```bash
rd echo "process item"
```

- PASS: CONTINUE
- FAIL: STOP

## Cleanup

Handle any failures.

```bash
rd echo "cleanup resources"
```

- PASS: COMPLETE
- FAIL: STOP
