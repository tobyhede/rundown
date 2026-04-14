---
name: End-to-End Test
description: Run write-plan, review-plan, then collect execution feedback
tags:
  - meta
  - feedback
---

# End-to-End Test

## 1. Execute planning workflow
- PASS ALL CONTINUE
- FAIL ANY STOP

### 1.1 Write plan

- planning/write-plan.runbook.md

### 1.2 Review plan

Delegate `planning/review-plan.runbook.md`, passing `PlanPath` resolved from:

`rdpath --dir {{ WorkPath }} --ctx {{ ContextId }} --file plan.json`

## 2. Collect feedback
- PASS COMPLETE
- FAIL COMPLETE

Review each step for clarity and friction.
Note any instructions that were ambiguous, missing, or required improvisation.
Include an overall assessment of the skill and runbook quality.
Write your feedback to the output path using the Review JSON schema.

Schema: `{{ CLAUDE_PLUGIN_ROOT }}/schemas/review.schema.json`

```bash
rdpath --dir {{ WorkPath }} --ctx {{ ContextId }} --file feedback.json
```
