# Dynamic Step With Mixed Substeps

Demonstrates dynamic steps with both static and named substeps.

## {N}. Process Batch

### {N}.1 Prepare
- PASS: CONTINUE
- FAIL: GOTO {N}.Recovery

Prepare batch N for processing.

```bash
rd echo "prepare batch"
```


### {N}.2 Execute
- PASS: GOTO NEXT
- FAIL: GOTO {N}.Recovery

Process the batch.

```bash
rd echo "process batch"
```


### {N}.Recovery
- PASS: GOTO NEXT
- FAIL: STOP

Handle batch processing failure.

```bash
rd echo "recover from failure"
```

