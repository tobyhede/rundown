# Mixed Named and Static Steps

## 1 First step
- PASS: CONTINUE

## 2 Second step
- PASS: CONTINUE

## 3 Third step
- FAIL: GOTO ErrorHandler
- PASS: COMPLETE

## ErrorHandler
Log the error and stop
- PASS: STOP ERROR
