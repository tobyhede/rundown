# GOTO {N}.{n} - Resume at Current Context

Demonstrates error recovery that returns to exactly where we came from.

Use case: Processing items in batches. When an item fails, we jump to
ErrorHandler. After recovery, we either:
- Resume the same item (GOTO {N}.{n})
- Skip to next item (GOTO NEXT {N}.{n})

## {N}. Process Batch

### {N}.{n} Handle Item

Process the current item in the current batch.

```bash
rd echo --result pass --result fail
```

- PASS: GOTO NEXT {N}.{n}
- FAIL: GOTO ErrorHandler

## ErrorHandler

Attempt to recover from the failure.
Runtime tracks which {N} and {n} we came from.

```bash
rd echo --result pass --result fail
```

- PASS: GOTO {N}.{n}
- FAIL: GOTO NEXT {N}.{n}
```

**Runtime state example:**

Given: {N} = 3 (batch 3), {n} = 2 (item 2)
- Item fails → jumps to ErrorHandler
- ErrorHandler PASS → `GOTO {N}.{n}` returns to batch 3, item 2 (retry same item)
- ErrorHandler FAIL → `GOTO NEXT {N}.{n}` skips to batch 3, item 3 (skip to next)
