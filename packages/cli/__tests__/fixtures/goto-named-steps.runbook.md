## Setup (name: Setup)

- PASS: CONTINUE
- FAIL: STOP

Initialize the runbook.

```bash
rd echo --result pass
```

## ProcessData (name: ProcessData)

- PASS: CONTINUE
- FAIL: STOP

Process the data.

```bash
rd echo --result pass
```

## ErrorHandler (name: ErrorHandler)

- PASS: COMPLETE
- FAIL: STOP

Handle any errors that occurred.

```bash
rd echo --result pass
```
