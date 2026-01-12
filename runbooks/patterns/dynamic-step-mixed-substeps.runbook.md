# Dynamic Step With Mixed Substeps

Demonstrates dynamic steps with both static and named substeps.

## {N}. Process Batch

### {N}.1 Prepare

Prepare batch N for processing.

```bash
rd echo "prepare batch"
```

- PASS: CONTINUE
- FAIL: GOTO {N}.Recovery

### {N}.2 Execute

Process the batch.

```bash
rd echo "process batch"
```

- PASS: GOTO NEXT
- FAIL: GOTO {N}.Recovery

### {N}.Recovery

Handle batch processing failure.

```bash
rd echo "recover from failure"
```

- PASS: GOTO NEXT
- FAIL: STOP
