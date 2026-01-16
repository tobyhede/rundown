---
name: multi-agent-dynamic
description: Multiple agents work on different runbooks with dynamic iteration

scenarios:
  two-agents-cycle:
    description: Two agents complete one iteration then finalize
    commands:
      - rd run --prompted multi-agent-dynamic.runbook.md
      - rd run --step 1.1 agent-task-lint.runbook.md
      - rd run --agent lint-agent
      - rd pass --agent lint-agent
      - rd run --step 1.2 agent-task-test.runbook.md
      - rd run --agent test-agent
      - rd pass --agent test-agent
      - rd fail
      - rd pass
    result: COMPLETE
tags:
  - composition
  - dynamic
---

# Multi-Agent Dynamic Runbook

Demonstrates multiple agents working on different runbooks with dynamic iteration.

## {N}. Process Work Items

- PASS: GOTO NEXT
- FAIL: GOTO Finalize

### {N}.1 Lint Agent

- PASS: CONTINUE
- FAIL: STOP

- agent-task-lint.runbook.md

### {N}.2 Test Agent

- PASS: CONTINUE
- FAIL: STOP

- agent-task-test.runbook.md

## Finalize

- PASS: COMPLETE
- FAIL: STOP

All agents completed their work.
