# Mixed Dynamic And Named With Recovery

Demonstrates dynamic iteration with a named recovery step.

## {N}. Process Item

Process each item.

```bash
rd echo "process item"
```

- PASS: GOTO NEXT
- FAIL: GOTO Recovery


## Recovery

Handle processing failures and resume iteration.

```bash
rd echo "recovery action"
```

- PASS: GOTO {N}
- FAIL: STOP "Recovery failed"

