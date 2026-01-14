---
name: goto-dynamic-substep-from-named
description: Demonstrates GOTO {N}.Name - jumping to a named substep within a dynamic step

scenarios:
  cleanup-failure:
    description: Cleanup substep fails causing workflow to stop
    commands:
      - rd run --prompted goto-dynamic-substep-from-named.runbook.md
      - rd pass
      - rd fail
      - rd fail
    result: STOP
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