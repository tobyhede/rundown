---
name: End-to-End Test
description: Run a target runbook then collect execution feedback
tags:
  - meta
  - feedback
vars:
  TargetRunbook: ""
---

# End-to-End Test

## 1. Execute workflow

- PASS ALL CONTINUE
- FAIL ANY STOP

- {{ TargetRunbook }}

## 2. Collect feedback
- PASS COMPLETE
- FAIL COMPLETE

Rate each step for clarity and friction. Note any instructions that were ambiguous, missing, or required improvisation. Include an overall assessment of the skill and runbook quality. Write execution feedback to the output path.

Schema: `${CLAUDE_PLUGIN_ROOT}schemas/feedback.schema.json`

```bash
rdpath --dir {{ WorkPath }} --ctx {{ ContextId }} --file feedback.json
```
