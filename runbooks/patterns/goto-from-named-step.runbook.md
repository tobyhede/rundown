# GOTO From Named Step

Demonstrates navigation from a named step to a numbered step.

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

Handle errors and retry.

```bash
rd echo "handle error"
```

- PASS: GOTO 1
- FAIL: STOP
