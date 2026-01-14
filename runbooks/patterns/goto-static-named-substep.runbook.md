---
name: goto-static-named-substep
description: Demonstrates GOTO N.Name pattern for jumping to named substeps within static steps

scenarios:
  successful-flow:
    description: Prepare succeeds, jumps to Cleanup, then Execute completes
    commands:
      - rd run --prompted goto-static-named-substep.runbook.md
      - rd pass
      - rd pass
      - rd pass
    result: COMPLETE

  prepare-fails:
    description: Prepare fails, stops workflow
    commands:
      - rd run --prompted goto-static-named-substep.runbook.md
      - rd fail
    result: STOP

  execute-success:
    description: Prepare and Cleanup succeed, Execute passes directly to completion
    commands:
      - rd run --prompted goto-static-named-substep.runbook.md
      - rd pass
      - rd pass
      - rd pass
    result: COMPLETE

  execute-failure-cleanup:
    description: Prepare and Cleanup succeed, Execute fails and jumps to Cleanup again
    commands:
      - rd run --prompted goto-static-named-substep.runbook.md
      - rd pass
      - rd pass
      - rd fail
      - rd pass
      - rd pass
    result: COMPLETE
---

# GOTO Static Named Substep

Demonstrates GOTO N.Name - jumping to a named substep within a static step.

## 1. Setup

### 1.1 Prepare
- PASS: GOTO 1.Cleanup
- FAIL: STOP

Initial preparation.

```bash
rd echo "prepare environment"
```


### 1.Cleanup
- PASS: CONTINUE
- FAIL: STOP

Named cleanup substep.

```bash
rd echo "cleanup resources"
```


## 2. Execute
- PASS: COMPLETE
- FAIL: GOTO 1.Cleanup

Main execution.

```bash
rd echo "execute main task"
```

