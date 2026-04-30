---
name: snapshot-child
description: Child runbook that consumes Message from parent delegation
inputs:
  - Message
---
# Snapshot Child

## 1. Child step
- PASS COMPLETE
- FAIL STOP

The message is: {{Message}}
