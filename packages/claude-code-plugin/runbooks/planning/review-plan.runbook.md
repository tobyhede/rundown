---
name: review-plan
description: Review and validate an implementation plan
tags:
  - planning
  - review
REQUIRED:
  - PlanPath
INPUTS:
  - PlanPath
OUTPUTS:
  - ReviewPlanPath
---


# Review Implementation Plan

Review the plan at the provided path.

## 1. Find plan
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
- DELEGATE
- PASS ALL CONTINUE
- FAIL ANY STOP

- review-plan-technical-accuracy.runbook.md
- review-plan-structural-integrity.runbook.md
- review-plan-build-runtime.runbook.md
- review-plan-risk-safety.runbook.md


## 4. Collate review findings
- DELEGATE
- PASS ALL COMPLETE
- FAIL ANY STOP

- review-plan-collate.runbook.md
