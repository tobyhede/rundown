# Mixed Named and Dynamic Steps

## {N}. Process Item
### {N}.1 Execute
- FAIL: GOTO {N}.Recovery
- PASS: GOTO NEXT

### {N}.Recovery Recovery
- PASS: GOTO NEXT
- FAIL: GOTO GlobalError

## GlobalError
- PASS: STOP "All items failed"


Handle global errors
