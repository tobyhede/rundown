# Invalid GOTO {N}.M from Static Context

This tests that GOTO {N}.M is rejected from static step context.

## 1. Static step
- PASS: GOTO {N}.1
- FAIL: STOP

Cannot reference {N}.M from here.
