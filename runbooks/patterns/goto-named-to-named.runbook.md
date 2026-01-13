# GOTO Named To Named

Demonstrates navigation between named steps.

## 1. Setup
- PASS: CONTINUE
- FAIL: GOTO ErrorHandler

Initial setup.

```bash
rd echo "initial setup"
```


## 2. Execute
- PASS: COMPLETE
- FAIL: GOTO ErrorHandler

Main execution.

```bash
rd echo "main execution"
```


## ErrorHandler
- PASS: GOTO 1
- FAIL: GOTO Fallback

Primary error handler.

```bash
rd echo "handle error"
```


## Fallback
- PASS: COMPLETE "Recovered via fallback"
- FAIL: STOP "Unrecoverable error"

Final fallback handler.

```bash
rd echo "fallback recovery"
```

