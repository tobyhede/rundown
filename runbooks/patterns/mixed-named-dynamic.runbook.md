# Mixed Named and Dynamic Steps

## {N} Process each item
### {N}.1 Do work
- FAIL: GOTO {N}.Recovery
- PASS: GOTO NEXT

### {N}.Recovery Handle recovery
- PASS: GOTO NEXT
- FAIL: GOTO GlobalError

## GlobalError
Handle global errors
- PASS: STOP "All items failed"
