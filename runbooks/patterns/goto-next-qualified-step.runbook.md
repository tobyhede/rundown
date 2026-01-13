# GOTO NEXT {N} - Explicit Step Advancement

Demonstrates explicitly advancing to next step instance from anywhere.

## {N}. Main Loop
- PASS: GOTO NEXT
- FAIL: GOTO ErrorHandler

```bash
rd echo --result pass --result fail
```


## ErrorHandler
- PASS: GOTO NEXT {N}
- FAIL: STOP

Handles errors and returns to main loop.

```bash
rd echo --result pass
```

