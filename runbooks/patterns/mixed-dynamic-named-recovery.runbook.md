# Mixed Dynamic And Named With Recovery

Demonstrates dynamic iteration with a named recovery step.

## {N}. Process Item
- PASS: GOTO NEXT
- FAIL: GOTO Recovery

Process each item.

```bash
rd echo "process item"
```



## Recovery
- PASS: GOTO {N}
- FAIL: STOP "Recovery failed"

Handle processing failures and resume iteration.

```bash
rd echo "recovery action"
```


