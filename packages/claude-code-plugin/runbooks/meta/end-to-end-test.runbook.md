---
name: End-to-End Test
description: Run write-plan, review-plan, then collect execution feedback
tags:
  - meta
  - feedback
---

# End-to-End Test

## 1. Run write-plan

- PASS CONTINUE
- FAIL STOP

planning/write-plan.runbook.md

## 2. Run review-plan

- PASS CONTINUE
- FAIL STOP

Run `planning/review-plan.runbook.md` with `PlanPath` set to the plan output from the previous step.

PlanPath:
```bash
rdpath --dir {{ WorkPath }} --ctx {{ ContextId }} --file plan.json
```

## 3. Collect feedback
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
