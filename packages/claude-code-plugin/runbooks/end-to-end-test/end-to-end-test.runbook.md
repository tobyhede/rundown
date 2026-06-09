---
name: end-to-end-test-runbook
description: Run an end-to-end workflow that mirrors planning with nested delegated reviews.
OUTPUTS:
 - FeedbackPath
---

# End-to-End Test Runbook

Test the end-to-end runbook workflow and provide structured test & review feedback.


## 1. Read the output schema
- ARTIFACTS
  - ReviewSchemaPath "schemas/review.schema.json"
- PASS CONTINUE
- FAIL STOP

The schema defines the expected feedback output structure.


## 2. Write
- PASS ALL CONTINUE
- FAIL ANY STOP

- end-to-end-test/write-file.runbook.md


## 3. Review
- PASS ALL CONTINUE
- FAIL ANY STOP

- end-to-end-test/review-and-collate.runbook.md


## 4. Write the feedback
- ARTIFACTS
  - ReviewSchemaPath
  - CollatedReviewPath
  - FeedbackPath "end-to-end-test-feedback.json"
- PASS CONTINUE
- FAIL STOP

Read the collated review from `{{ path CollatedReviewPath }}`.
Write the final feedback to `{{ path FeedbackPath }}` as JSON.
Follow the output schema from `{{ path ReviewSchemaPath }}`.


## 5. Check Schema
- PASS COMPLETE
- FAIL GOTO 4

```bash
rdx {{ path FeedbackPath }} --validate --schema review
```
