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

## 1. Run the target runbook

- PASS ALL CONTINUE
- FAIL ANY STOP

- {{ TargetRunbook }}

## 2. Collect feedback
- PASS COMPLETE
- FAIL COMPLETE

Review each step for clarity and friction.
Note any instructions that were ambiguous, missing, or required improvisation.
Include an overall assessment of the skill and runbook quality.
Write your feedback to the output path using the Feedback JSON schema.

Schema: `{{ CLAUDE_PLUGIN_ROOT }}/schemas/feedback.schema.json`

```bash
rdpath --dir {{ WorkPath }} --ctx {{ ContextId }} --file feedback.json
```
