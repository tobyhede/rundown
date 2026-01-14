---
name: dynamic-step-named-substep
description: Tests dynamic steps with custom-named substeps and GOTO navigation to named steps

scenarios:
  happy-path:
    description: Pass through substep 1 to reach named substep and complete
    commands:
      - rd run --prompted dynamic-step-named-substep.runbook.md
      - rd pass  # Substep 1 - GOTO {N}.Named
      - rd pass  # Named Substep - COMPLETE
    result: COMPLETE

  skip-substep-2:
    description: Demonstrates skipping substep 2 using GOTO to named step
    commands:
      - rd run --prompted dynamic-step-named-substep.runbook.md
      - rd pass  # Substep 1 - GOTO {N}.Named, skips substep 2
      - rd pass  # Named Substep - COMPLETE
    result: COMPLETE
---

# Dynamic Step With Named Substep

## {N}. Dynamic

### {N}.1 Substep 1
- PASS: GOTO {N}.Named


```bash
rd echo --result pass
```

### {N}.2 Substep 2
Substep 2 should be skipped
```bash
rd echo --result fail
```

### {N}.Named Substep with Name
- PASS: COMPLETE


```bash
rd echo --result pass
```
