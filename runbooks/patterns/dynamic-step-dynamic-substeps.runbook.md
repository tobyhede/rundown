# Dynamic Step With Dynamic Substeps

Demonstrates doubly-dynamic iteration with {N}.{n} pattern.

## {N}. Process Batch

### {N}.{n} Process Item
Process each item in batch N.

- PASS: CONTINUE
- FAIL: STOP

```bash
rd echo "process item"
```


## Cleanup
Handle any failures.

- PASS: COMPLETE
- FAIL: STOP

```bash
rd echo "cleanup resources"
```

