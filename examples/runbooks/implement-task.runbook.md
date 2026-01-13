# Implement Task

Execute tasks from the implementation plan sequentially.

## {N}. Task

### {N}.1 Implement

- NO: GOTO {N}.3
- YES: GOTO {N}.2

Follow the plan exactly.

Required changes from plan?

### {N}.2 Evaluate

- YES: CONTINUE
- NO: STOP "STOPPED: Changes exceed implementation boundaries"

Assess changes to logic, dependencies, scope, interfaces.

Within implementation boundaries?

### {N}.3 Checks

- PASS: CONTINUE
- FAIL: GOTO {N}.5

```bash
tsv echo npm run lint && tsv echo npm run build
```

### {N}.4 Tests

- PASS: CONTINUE
- FAIL: GOTO {N}.5

```bash
tsv echo npm test
```

### {N}.5 Troubleshoot

- YES: GOTO {N}.6
- NO: STOP "STOPPED: Requires plan revision"

Can you fix without changing approach?

### {N}.6 Apply fixes

- PASS: GOTO {N}.3
- FAIL: STOP "STOPPED: Could not apply fixes"

Apply inline fixes.

### {N}.7 Complete

- YES: GOTO NEXT
- NO: COMPLETE

```
STATUS: OK
TASK: {N}
```

More tasks?
