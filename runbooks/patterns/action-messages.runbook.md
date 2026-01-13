---
name: action-messages
description: Demonstrates STOP and COMPLETE with message parameters
tags: [transitions, messages]

scenarios:
  complete-with-message:
    commands:
      - rd run --prompted action-messages.runbook.md
      - rd pass
    result: COMPLETE
---

# Action Messages

Shows STOP/COMPLETE with descriptive messages.

## 1. Check Status

- PASS: COMPLETE "Setup completed successfully"
- FAIL: STOP "Setup failed - check prerequisites"

Verify system is ready.
