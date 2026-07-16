---
name: inline-child-goto-stop
description: Child that waits at a content step, then a goto-driven Finish command fails and STOPs (inline composition target for goto propagation)
tags:
  - composition

scenarios:
  goto-to-stop:
    description: Child auto-waits at the content-only step 1; goto jumps to the Finish command which auto-executes, fails, and STOPs the child
    commands:
      - rd run inline-child-goto-stop.runbook.md
      - rd goto 2
    result: STOP
---

# Inline Child (Goto Stop)

Child runbook used as an inline composition target for goto-driven failure
propagation. Its first step is content-only, so the run loop waits there until a
`goto` jumps to the Finish command, which fails and STOPs.

## 1. Start

- PASS CONTINUE

Waiting for a goto to the Finish step.

## 2. Finish

- FAIL STOP

```bash
rd echo --result fail "child finish failed"
```
