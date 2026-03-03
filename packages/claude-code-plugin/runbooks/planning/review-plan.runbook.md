---
name: review-plan
description: Review and validate an implementation plan
tags:
  - planning
  - review
---

# Review Implementation Plan

Systematically review an implementation plan for quality and completeness.

**OBJECTIVE:** Validate the plan before implementation begins.

**DONE WHEN:** Plan is approved or feedback provided.

## 1 Check Completeness

- PASS: CONTINUE
- FAIL: STOP "Plan is incomplete."

Verify the plan includes all required sections:

- Overview
- File changes
- Testing approach
- Verification steps

## 2 Verify Feasibility

- PASS: CONTINUE
- FAIL: STOP "Plan has feasibility issues."

Check that the proposed changes are technically feasible.

## 3 Review Dependencies

- PASS: CONTINUE
- FAIL: STOP "Dependency issues found."

Verify dependencies are correctly identified and ordered.

## 4 Final Decision

- YES: COMPLETE "Plan approved for implementation."
- NO: STOP "Plan requires revisions."

Is the plan ready for implementation?
