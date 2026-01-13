# Code Blocks

Demonstrates various code block patterns in workflows.

## 1. Setup
- PASS: CONTINUE
- FAIL: STOP

Setup with bash command.

```bash
rd echo "setup environment"
```


## 2. Execute
- PASS: CONTINUE
- FAIL: STOP

Execute with multiple commands.

```bash
rd echo "Starting execution"
rd echo "run main task"
```


## 3. Validate
- PASS: COMPLETE
- FAIL: STOP

Validate with conditional.

```bash
rd echo "Validating..."
rd echo "validate results"
```

