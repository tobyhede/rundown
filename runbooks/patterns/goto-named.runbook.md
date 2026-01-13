# GOTO Named Step
Demonstrates GOTO <name> - jumping to a named step.

## Initialize
- PASS: CONTINUE
- FAIL: GOTO Cleanup

Set up the workflow.

```bash
rd echo --result pass
```


## Process
- PASS: GOTO Cleanup
- FAIL: GOTO ErrorHandler

Do the main work.

```bash
rd echo --result pass
```


## ErrorHandler
- PASS: GOTO Cleanup
- FAIL: STOP

Handle errors.

```bash
rd echo --result pass
```


## Cleanup
- PASS: COMPLETE
- FAIL: STOP

Clean up resources.

```bash
rd echo --result pass
```

