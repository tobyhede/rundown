---
name: inline-composition-stop
description: Parent whose single inline substep aggregates FAIL ANY STOP, so an inline child's failure stops the parent in the same command
tags:
  - composition
  - inline

scenarios:
  run-drives-inline-stop:
    description: rundown run launches an auto-failing inline child; Collecting its fail aggregates FAIL ANY STOP and the parent stops in the same command
    commands:
      - "! rd run inline-composition-stop.runbook.md"
    result: STOP
---

# Inline Composition (Stop)

Exercises inline child execution where the composing parent has a **single**
inline substep under `FAIL ANY STOP`. The child fails on its own, so Collecting
its result aggregates immediately and the parent reaches a STOP terminal during
`rundown run` itself.

## 1. Review

- PASS ALL CONTINUE
- FAIL ANY STOP

### 1.1 Inline gate

- inline-child-fail.runbook.md

## 2. Done

- PASS COMPLETE

All reviews complete.
