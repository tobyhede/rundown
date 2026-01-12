# Named Steps Example

## 1 Main workflow
Do the main work
- FAIL: GOTO ErrorHandler
- PASS: COMPLETE SUCCESS

## ErrorHandler
Handle any errors that occur
- PASS: STOP RECOVERED
- FAIL: STOP "Unrecoverable error"
