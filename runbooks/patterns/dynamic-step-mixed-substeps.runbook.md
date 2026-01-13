# Dynamic Step With Mixed Substeps

Demonstrates dynamic steps with both static and named substeps.

## {N}. Process Batch

### {N}.1 Prepare
Prepare batch N for processing.

- PASS: CONTINUE
- FAIL: GOTO {N}.Recovery

```bash
rd echo "prepare batch"
```


### {N}.2 Execute
Process the batch.

- PASS: GOTO NEXT
- FAIL: GOTO {N}.Recovery

```bash
rd echo "process batch"
```


### {N}.Recovery
Handle batch processing failure.

- PASS: GOTO NEXT
- FAIL: STOP

```bash
rd echo "recover from failure"
```

