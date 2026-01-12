# GOTO NEXT {N} - Explicit Step Advancement

Demonstrates explicitly advancing to next step instance from anywhere.

## {N}. Main Loop

```bash
rd echo --result pass --result fail
```

- PASS: GOTO NEXT
- FAIL: GOTO ErrorHandler

## ErrorHandler

Handles errors and returns to main loop.

```bash
rd echo --result pass
```

- PASS: GOTO NEXT {N}
- FAIL: STOP
