---
name: delegate-for-loop
description: FOR loop with delegation — each iteration delegates to a child runbook (NOT YET SUPPORTED)
tags:
  - delegation
  - for-loops
  - pending
# NOTE: No scenarios — delegation within FOR loop iterations is not yet supported.
# The delegate command fails when the cursor is at a FOR loop iteration substep.
# This file documents the desired pattern for future implementation.
---

# FOR Delegation

Each iteration delegates to a child runbook.

**Status**: Not yet supported. Delegation within FOR loop iterations fails because
the delegation system does not handle FOR-qualified step positions.

## 1. Process items

- FOR item IN 1 TO 2
  - PASS: DEFER
  - FAIL: BREAK
- PASS ALL: COMPLETE
- FAIL ANY: STOP

### 1.1 Handle {{item}}

Delegated to child runbook.

- delegation-child-pass.runbook.md
