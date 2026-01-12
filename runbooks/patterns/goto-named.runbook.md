# GOTO Named Step
Demonstrates GOTO <name> - jumping to a named step.

## Initialize

Set up the workflow.

```bash
rd echo --result pass
```

- PASS: CONTINUE
- FAIL: GOTO Cleanup

## Process

Do the main work.

```bash
rd echo --result pass
```

- PASS: GOTO Cleanup
- FAIL: GOTO ErrorHandler

## ErrorHandler

Handle errors.

```bash
rd echo --result pass
```

- PASS: GOTO Cleanup
- FAIL: STOP

## Cleanup

Clean up resources.

```bash
rd echo --result pass
```

- PASS: COMPLETE
- FAIL: STOP
