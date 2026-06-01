---
name: snapshot-delegation-outputs
description: Step 1 sets Message via OUTPUTS, then step 2 delegates substep 2.1 to child
---
# Delegation with Outputs

## 1. Set message
- PASS CONTINUE
- FAIL STOP
- OUTPUTS
  - Message

```bash
printf '%s' 'hello from snapshot parent' > "$RD_OUTPUTS_Message"
```

## 2. Delegate work
- PASS ALL COMPLETE
- FAIL ANY STOP

### 2.1 Child task
- DELEGATE

Delegated to child runbook.
