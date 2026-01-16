---
name: discover-rundown
description: Experience Rundown in 60 seconds
scenarios:
  tour:
    description: Complete the guided tour
    commands:
      - rd run --prompted discover-rundown.runbook.md
      - rd pass
      - rd pass
      - rd pass
      - rd pass
      - rd pass
    result: COMPLETE
  retry-demo:
    description: Experience retry exhaustion
    commands:
      - rd run --prompted discover-rundown.runbook.md
      - rd pass
      - rd pass
      - rd pass
      - rd fail
      - rd fail
      - rd fail
    result: STOP
  quick:
    description: Jump straight to the end
    commands:
      - rd run --prompted discover-rundown.runbook.md
      - rd goto 5
      - rd pass
    result: COMPLETE
---

# Discover Rundown

## 1 This Is Markdown That Executes
- PASS: CONTINUE
- FAIL: STOP

Welcome. You are reading an executable specification.
H2 headers become steps. Bullet points become transitions. Code blocks become commands.
Click "Next Step" to continue.

## 2 Deterministic Control
- PASS: CONTINUE
- FAIL: STOP

AI agents skip steps, forget context, go off-track.
Rundown enforces: PASS/FAIL maps to CONTINUE/STOP/GOTO/RETRY.
Progress is tracked. Order is guaranteed.

## 3 State That Survives
- PASS: CONTINUE
- FAIL: STOP

Close this tab. Clear your browser. State persists in `.claude/rundown/`.
No database. Just files you version control.

## 4 Graceful Failure
- PASS: CONTINUE
- FAIL: RETRY 2 GOTO Recovery

Networks timeout. APIs fail. Tests flake.
RETRY handles it. Try failing this step. You get 2 retries.

## Recovery
- PASS: GOTO 5
- FAIL: STOP

Named steps for error handlers and conditional logic.
GOTO brought you here. PASS to continue.

## 5 You Just Experienced It
- PASS: COMPLETE
- FAIL: STOP

In 60 seconds: executable markdown, deterministic control,
persistent state, retry handling, GOTO navigation.

Ready?
