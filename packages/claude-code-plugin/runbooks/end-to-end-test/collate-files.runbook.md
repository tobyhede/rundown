---
name: collate-files
description: Read end-to-end workflow artifacts and write one collated review artifact.
tags:
  - meta
  - e2e
INPUTS:
  - PlanPath
REQUIRED:
  - PlanPath
OUTPUTS:
  - CollatedReviewPath
---

# End-to-End Test Collate

Collate review feedback into single structured review.


## 1. Read the output schema
- ARTIFACTS
  - ReviewSchemaPath "schemas/review.schema.json"
- PASS CONTINUE
- FAIL STOP

The schema defines the expected output structure.


## 2. Write collated review
- ARTIFACTS
  - PlanPath
  - ReviewSchemaPath
  - ReviewPaths "*/end-to-end-test-review.json"
  - CollatedReviewPath "end-to-end-test-collated-review.json"
- PASS CONTINUE
- FAIL STOP

Read all review files: `{{ path ReviewPaths }}`.
Merge findings from all reviews into a single canonical review document.

Deduplicate equivalent findings — when multiple reviews identify the same issue, merge their descriptions, evidence, and rationale rather than discarding duplicates.
The combined context may influence recommended actions.

Write the collated JSON review to `{{ path CollatedReviewPath }}`.
Follow the output schema from `{{ path ReviewSchemaPath }}`.



## 3. Check Schema
- PASS COMPLETE
- FAIL GOTO 2

```bash
rdx {{ path CollatedReviewPath }} --validate --schema review
```
