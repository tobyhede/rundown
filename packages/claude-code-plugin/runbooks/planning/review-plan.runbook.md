---
name: review-plan
description: Review and validate an implementation plan
tags:
  - planning
  - review
required:
  - PlanPath
---

# Review Implementation Plan

Review the plan at `{{ PlanPath }}`.

`PlanPath` must be supplied by the caller. Resolve with `rdpath --dir {{ WorkPath }} --ctx {{ ContextId }} --file plan.json`.

## 1. Review the plan schema
- PASS CONTINUE
- FAIL STOP

Schema: `{{ CLAUDE_PLUGIN_ROOT }}/schemas/plan.schema.json`

## 2. Context and scope
- PASS CONTINUE
- FAIL STOP

Verify the plan includes:
- A specific, testable goal (one sentence)
- Explicit success criteria
- Defined scope boundaries (in-scope and out-of-scope)
- Accurate assumptions about current state

Read the plan at `{{ PlanPath }}` and validate these elements exist and are coherent.

## 3. Delegate subagents to review the plan
- PASS ALL CONTINUE
- FAIL ANY CONTINUE

Delegate subagents to review

- review-technical-accuracy.runbook.md
- review-structural-integrity.runbook.md
- review-build-runtime.runbook.md
- review-risk-safety.runbook.md

## 4. Collate review documents
- PASS ALL COMPLETE
- FAIL ANY STOP

- review-synthesize.runbook.md

