# GOTO Named To Named

Demonstrates navigation between named steps.

## 1. Setup

Initial setup.

```bash
rd echo "initial setup"
```

- PASS: CONTINUE
- FAIL: GOTO ErrorHandler

## 2. Execute

Main execution.

```bash
rd echo "main execution"
```

- PASS: COMPLETE
- FAIL: GOTO ErrorHandler

## ErrorHandler

Primary error handler.

```bash
rd echo "handle error"
```

- PASS: GOTO 1
- FAIL: GOTO Fallback

## Fallback

Final fallback handler.

```bash
rd echo "fallback recovery"
```

- PASS: COMPLETE "Recovered via fallback"
- FAIL: STOP "Unrecoverable error"
