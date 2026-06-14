---
name: address-review
description: Resolve the error-level findings recorded by a code review, committing the fix.
skill: executing-plans
tags:
  - planning
INPUTS:
  - PlanPath
  - CodeReviewPath
REQUIRED:
  - PlanPath
  - CodeReviewPath
---

# Address Review Findings

Resolve the blocking findings from the code review.

## 1. Invoke the Executing Plans skill
- PASS CONTINUE
- FAIL STOP

Invoke and read the executing-plans skill. Internalize the per-task cycle and commit discipline.

Skill: `rundown:executing-plans`


## 2. Read the review and plan
- ARTIFACTS
  - PlanPath
  - CodeReviewPath
- PASS CONTINUE
- FAIL STOP

Read the recorded findings at `{{ path CodeReviewPath }}` and the plan at `{{ path PlanPath }}`.


## 3. Resolve the findings
- PASS COMPLETE
- FAIL STOP

Resolve every `error`-level finding, staying within the plan's intent. Add or update tests as needed, then commit the fix. Stop and escalate if a finding cannot be resolved within scope.
