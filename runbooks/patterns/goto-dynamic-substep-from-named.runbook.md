---
title: GOTO Dynamic Named Substep
description: Demonstrates GOTO {N}.Name - jumping to a named substep within a dynamic step
tags: [goto, dynamic, substep, named]
---

# GOTO Dynamic Named Substep

Demonstrates `GOTO {N}.Name` - jumping to a named substep within a dynamic step.

## {N}. Process Item

### {N}.Validate
Validate the current item.

- PASS: CONTINUE
- FAIL: GOTO {N}.Cleanup

### {N}.Execute
Execute processing for validated item.

- PASS: GOTO NEXT
- FAIL: GOTO {N}.Cleanup

### {N}.Cleanup
Clean up after validation or execution failure.

- PASS: GOTO NEXT
- FAIL: STOP
