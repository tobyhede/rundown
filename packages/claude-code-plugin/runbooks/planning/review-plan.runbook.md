---
name: review-plan
description: Review and validate an implementation plan
tags:
  - planning
  - review
---

# Review Implementation Plan

Review the plan in the current context.

## 1. Find plan
- PASS CONTINUE
- FAIL STOP

```bash
rdpath --dir {{ WorkPath }} --ctx {{ ContextId }} find "*plan.json"
```

## 2. Context and scope
- PASS CONTINUE
- FAIL STOP

Read the plan and validate these elements exist and are coherent.

Verify the plan includes:
- A clear, concise description of the desired outcome.
- Explicit success criteria
- Clearly defined scope
- Accurate assumptions about current state

## 3. Delegate subagents to review the plan
- PASS ALL CONTINUE
- FAIL ANY CONTINUE

Delegate subagents to review the plan.

- review-technical-accuracy.runbook.md
- review-structural-integrity.runbook.md
- review-build-runtime.runbook.md
- review-risk-safety.runbook.md

## 4. Collate review documents
- PASS ALL COMPLETE
- FAIL ANY STOP

- review-synthesize.runbook.md
