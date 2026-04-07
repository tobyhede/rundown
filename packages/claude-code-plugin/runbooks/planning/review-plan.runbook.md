---
name: review-plan
description: Review and validate an implementation plan
tags:
  - planning
  - review
---

# Review Implementation Plan

Review the plan in the current context.

## 1. Resolve plan path
- PASS CONTINUE
- FAIL STOP

```bash
rdpath --dir {{ WorkPath }} --ctx {{ ContextId }} find "*plan.json"
```

## 2. Review the plan schema
- PASS CONTINUE
- FAIL STOP

Validate the plan found in step 1 against the schema.

Schema: `{{ CLAUDE_PLUGIN_ROOT }}/schemas/plan.schema.json`

## 3. Context and scope
- PASS CONTINUE
- FAIL STOP

Verify the plan includes:
- A specific, testable goal (one sentence)
- Explicit success criteria
- Defined scope boundaries (in-scope and out-of-scope)
- Accurate assumptions about current state

Read the plan found in step 1 and validate these elements exist and are coherent.

## 4. Delegate subagents to review the plan
- PASS ALL CONTINUE
- FAIL ANY CONTINUE

Delegate subagents to review

- review-technical-accuracy.runbook.md
- review-structural-integrity.runbook.md
- review-build-runtime.runbook.md
- review-risk-safety.runbook.md

## 5. Collate review documents
- PASS ALL COMPLETE
- FAIL ANY STOP

- review-synthesize.runbook.md
