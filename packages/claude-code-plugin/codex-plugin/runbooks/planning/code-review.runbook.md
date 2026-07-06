---
name: code-review
description: Review implemented changes against the plan and record findings as a review document.
tags:
  - planning
  - review
INPUTS:
  - PlanPath
REQUIRED:
  - PlanPath
OUTPUTS:
  - CodeReviewPath
---

# Code Review

Review the implemented changes against the plan and record findings.

## 1. Read the output schema
- ARTIFACTS
  - ReviewSchemaPath "schemas/review.schema.json"
- PASS CONTINUE
- FAIL STOP

The schema defines the expected review output structure.


## 2. Read the plan
- ARTIFACTS
  - PlanPath
- PASS CONTINUE
- FAIL STOP

Read the plan at `{{ path PlanPath }}`. It defines the intended changes to review against.


## 3. Review the implemented changes
- PASS CONTINUE
- FAIL CONTINUE

Review the working-tree changes against the plan:

- Each planned task is implemented and matches its intent.
- No unplanned or out-of-scope changes.
- Tests cover the new behaviour and code follows project conventions.

Record findings; do not gate here.


## 4. Output Path
- ARTIFACTS
  - CodeReviewPath "code-review.json"
- PASS CONTINUE
- FAIL STOP

{{ CodeReviewPath }}


## 5. Write the review
- ARTIFACTS
  - PlanPath
  - ReviewSchemaPath
  - CodeReviewPath
- PASS CONTINUE
- FAIL STOP

Write the review to `{{ path CodeReviewPath }}` as JSON, following the schema from `{{ path ReviewSchemaPath }}`. Use `level: "error"` for findings that must block, `warning` or `note` otherwise. An empty `items` array records a clean review.


## 6. Check Schema
- PASS CONTINUE
- FAIL GOTO 5

```bash
{{ validateSchema CodeReviewPath }}
```


## 7. Gate the review
- ARTIFACTS
  - CodeReviewPath
- PASS COMPLETE
- FAIL STOP

You recorded the review at `{{ path CodeReviewPath }}`. Render the verdict.

Pass the gate when the review is clean — no findings that must block the work. Fail the gate when it holds blocking (`error`-level) findings the work must address before it can advance.

A review that records blocking findings is a failing review. The verdict is yours to make from the recorded review; do not soften it to keep the work moving.
