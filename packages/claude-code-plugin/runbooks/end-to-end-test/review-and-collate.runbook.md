---
name: end-to-end-test-review
description: Run the end-to-end review workflow and delegate the nested review.
tags:
  - meta
  - e2e
INPUTS:
  - PlanPath
REQUIRED:
  - PlanPath
OUTPUTS:
  - ReviewPath
  - CollatedReviewPath
---

# End-to-End Test Review and Collate

Delegate subagents to review the plan and collate the reviews.


## 1. Delegate subagents to review

- ARTIFACTS
  - PlanPath
- DELEGATE
- PASS ALL CONTINUE
- FAIL ANY STOP

- end-to-end-test/review-file.runbook.md


## 2. Delegate subagent to collate reviews
- DELEGATE
- PASS ALL COMPLETE
- FAIL ANY STOP

- end-to-end-test/collate-files.runbook.md
