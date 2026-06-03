---
name: invalid-delegate-authoring
description: Scenario coverage for invalid DELEGATE authoring rejection
tags:
  - delegation
  - invalid

scenarios:
  prompt-only-delegate-rejects-at-run:
    description: rd run rejects a prompt-only DELEGATE substep before execution
    commands:
      - printf '%s\n' '## 1. Parent' '- PASS ALL CONTINUE' '- FAIL ANY STOP' '' '### 1.1 Prompt delegate' '- DELEGATE' '- PASS CONTINUE' '- FAIL STOP' '' 'Review the deployment notes.' > invalid-prompt-only-delegate.md
      - "! rd run invalid-prompt-only-delegate.md"
    expect:
      errors:
        - code: VALIDATION_ERROR
          command: run
          error: DELEGATE requires a runbook reference.
---

# Invalid Delegate Authoring Scenarios

Scenario carrier for invalid DELEGATE authoring checks.

## 1. No-op

- PASS COMPLETE

This runbook is valid; scenarios create invalid runbooks dynamically.
