---
name: review-plan
description: Review and validate an implementation plan
required:
  - PlanPath
inputs:
  - PlanPath
tags:
  - planning
  - review
---

# Review Implementation Plan

Review the plan at the provided path.

## 1. Find plan
- INPUTS
  - PlanPath
- PASS CONTINUE
- FAIL STOP

Read the plan from `{{ PlanPath }}`.



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

Delegate 4x subagents to review the plan.
Delegate subagents for Steps 3.1 - 3.4.

- review-plan-technical-accuracy.runbook.md
- review-plan-structural-integrity.runbook.md
- review-plan-build-runtime.runbook.md
- review-plan-risk-safety.runbook.md


## 4. Collate review findings
- PASS ALL COMPLETE
- FAIL ANY STOP

Delegate a subagent to collate the review findings.

- review-plan-collate.runbook.md
