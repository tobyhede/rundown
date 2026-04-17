---
name: End-to-End Test
description: Run multiple runbooks and test the end-to-end process.
---

# End-to-End Test

Run multiple runbooks, reviewing and testing the end-to-end process.


## 1. Read the output schema
- PASS CONTINUE
- FAIL STOP

```prompt
{{ CLAUDE_PLUGIN_ROOT }}/schemas/review.schema.json
```

## 2. Write Plan
- PASS ALL CONTINUE
- FAIL ANY STOP

Delegate a subagent to write a plan.

- planning/write-plan.runbook.md


## 3. Review Plan
- PASS ALL CONTINUE
- FAIL ANY STOP

Delegate a subagent to review the plan.

- planning/review-plan.runbook.md



## 4. Write the review of the end-to-end Rundown workflow
- PASS CONTINUE
- FAIL STOP

Write the review to the output path as JSON.
Follow the review output schema.

```bash
rdpath --dir {{ WorkPath }} --ctx {{ ContextId }} --file review-end-to-end-{{ RunId }}.json
```


## 5. Check Schema
- PASS COMPLETE
- FAIL GOTO 4

```bash
rdx --check "$(rdpath --dir {{ WorkPath }} --ctx {{ ContextId }} --file review-plan-{{ RunId }}.json)"
```

