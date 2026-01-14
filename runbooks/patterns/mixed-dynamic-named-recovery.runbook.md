---
name: mixed-dynamic-named-recovery
description: Demonstrates dynamic iteration with a shared named recovery step that returns to iterate next item

scenarios:
  recovery-resumes:
    description: Process fails, recovery passes, resumes dynamic step, then fails to stop
    commands:
      - rd run --prompted mixed-dynamic-named-recovery.runbook.md
      - rd fail
      - rd pass
      - rd fail
      - rd fail
    result: STOP

  recovery-fails:
    description: Process fails, recovery fails, workflow stops
    commands:
      - rd run --prompted mixed-dynamic-named-recovery.runbook.md
      - rd fail
      - rd fail
    result: STOP
---

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


