---
name: execute-plan
description: Execute a reviewed plan — delegate implementation, then loop code review and verify gates until clean.
skill: executing-plans
tags:
  - planning
INPUTS:
  - PlanPath
REQUIRED:
  - PlanPath
OUTPUTS:
  - CodeReviewPath
---

# Execute Plan

Execute the plan, then hold the work to the review and verify gates.

## 1. Invoke the Executing Plans skill
- PASS CONTINUE
- FAIL STOP

Invoke and read the executing-plans skill. Internalize how implementation, review, and verification fit together.

Skill: `rundown:executing-plans`


## 2. Implement the plan
- ARTIFACTS
  - PlanPath
- DELEGATE
- PASS ALL CONTINUE
- FAIL ANY STOP

- implement-plan.runbook.md


## 3. Code review
- DELEGATE
- PASS ALL CONTINUE
- FAIL ANY STOP

- code-review.runbook.md


## 4. Is the review clean?
- ARTIFACTS
  - CodeReviewPath
- PASS GOTO 6
- FAIL CONTINUE

```bash
test "$(jq '[.items[] | select(.level == "error")] | length' "{{ path CodeReviewPath }}")" -eq 0
```


## 5. Address review findings
- DELEGATE
- PASS ALL GOTO 3
- FAIL ANY STOP

- address-review.runbook.md


## 6. Verify
- PASS COMPLETE
- FAIL GOTO 5

```bash
npm run verify
```
