# Code Blocks

Demonstrates various code block patterns in workflows.

## 1. Setup

Setup with bash command.

```bash
rd echo "setup environment"
```

- PASS: CONTINUE
- FAIL: STOP

## 2. Execute

Execute with multiple commands.

```bash
rd echo "Starting execution"
rd echo "run main task"
```

- PASS: CONTINUE
- FAIL: STOP

## 3. Validate

Validate with conditional.

```bash
rd echo "Validating..."
rd echo "validate results"
```

- PASS: COMPLETE
- FAIL: STOP
