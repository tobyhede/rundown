---
name: review-plan
description: Review and validate an implementation plan
tags:
  - planning
  - review
vars:
  PlanPath: .work/plan.md
---

# Review Implementation Plan

Review the plan at `{{ PlanPath }}`.

## 1. Context and scope

- PASS: CONTINUE
- FAIL: STOP "Plan lacks clear goal or scope."

Verify the plan includes:
- A specific, testable goal (one sentence)
- Explicit success criteria
- Defined scope boundaries (in-scope and out-of-scope)
- Accurate assumptions about current state

Read the plan at `{{ PlanPath }}` and validate these elements exist and are coherent.

## 2. Review the plan

- FOR pass IN 1 TO 2
- FAIL ANY: GOTO Synthesize

- review-technical-accuracy.runbook.md
- review-structural-integrity.runbook.md
- review-build-runtime.runbook.md
- review-risk-safety.runbook.md

## 3. Approved

- PASS: COMPLETE "Plan approved — no issues found."

Plan approved — no issues found across both review passes.

## Synthesize Collate findings and produce verdict

- review-synthesize.runbook.md
