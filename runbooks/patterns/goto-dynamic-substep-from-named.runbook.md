---
title: GOTO Dynamic Named Substep
description: Demonstrates GOTO {N}.Name - jumping to a named substep within a dynamic step
tags: [goto, dynamic, substep, named]
---

# GOTO Dynamic Named Substep

Demonstrates `GOTO {N}.Name` - jumping to a named substep within a dynamic step.

## {N}. Process Item

### {N}.Validate

- PASS: CONTINUE
- FAIL: GOTO {N}.Cleanup

Validate the current item.


### {N}.Execute

- PASS: GOTO NEXT
- FAIL: GOTO {N}.Cleanup

Execute processing for validated item.


### {N}.Cleanup

- PASS: GOTO NEXT
- FAIL: STOP

Clean up after validation or execution failure.

