# Dynamic Step With Dynamic Substeps

Demonstrates doubly-dynamic iteration with {N}.{n} pattern.

## {N}. Process Batch

### {N}.{n} Process Item
- PASS: CONTINUE
- FAIL: STOP

Process each item in batch N.

```bash
rd echo "process item"
```


## Cleanup
- PASS: COMPLETE
- FAIL: STOP

Handle any failures.

```bash
rd echo "cleanup resources"
```

