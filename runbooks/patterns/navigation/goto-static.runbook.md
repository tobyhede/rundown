---
name: goto-static
description: Demonstrates static GOTO patterns (Step, Substep, NEXT, Named Substep)
tags:
  - navigation
  - substeps

scenarios:
  goto-step:
    description: Jump from step 1 to step 3
    commands:
      - rd run --step 1 goto-static.runbook.md
      - rd pass
      - rd pass
    result: COMPLETE

  goto-substep:
    description: Jump from substep 4.1 to 4.3
    commands:
      - rd run --step 4 goto-static.runbook.md
      - rd pass
      - rd pass
    result: COMPLETE

  goto-next:
    description: Explicit jump to NEXT step
    commands:
      - rd run --step 6 goto-static.runbook.md
      - rd pass
      - rd pass
    result: COMPLETE

  goto-named-substep:
    description: Jump from 8.1 to 8.Cleanup
    commands:
      - rd run --step 8 goto-static.runbook.md
      - rd pass
      - rd pass
    result: COMPLETE
---

# Static GOTO Patterns

## 1. Step Jump
- PASS: GOTO 3
- FAIL: STOP

Please confirm to jump to step 3.

```bash
rd echo "jump start"
```

## 2. Skipped Step
- PASS: CONTINUE
- FAIL: STOP

This step should be skipped.

```bash
rd echo --result fail
```

## 3. Jump Target
- PASS: COMPLETE

Target of step jump.

```bash
rd echo "jump landed"
```

## 4. Substep Jump

### 4.1 Start
- PASS: GOTO 4.3
- FAIL: STOP

Please confirm to jump to substep 4.3.

```bash
rd echo "substep start"
```

### 4.2 Skipped
- PASS: CONTINUE

```bash
rd echo --result fail
```

### 4.3 Target
- PASS: COMPLETE

```bash
rd echo "substep landed"
```

## 5. Setup for Next
- PASS: CONTINUE

Just a spacer.

```bash
rd echo "spacer"
```

## 6. GOTO NEXT
- PASS: GOTO NEXT
- FAIL: STOP

Please confirm to jump to the next step.

Explicitly jumps to the next step (7).

```bash
rd echo "goto next"
```

## 7. Next Target
- PASS: COMPLETE

```bash
rd echo "next landed"
```

## 8. Named Substep Jump

### 8.1 Start
- PASS: GOTO 8.Cleanup
- FAIL: STOP

Please confirm to jump to the cleanup substep.

Jumps to a named substep in the same step.

```bash
rd echo "named start"
```

### 8.Cleanup
- PASS: COMPLETE

Target named substep.

```bash
rd echo "cleanup"
```
