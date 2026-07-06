---
name: review-file
description: Read the plan artifact and write one nested review artifact.
tags:
  - meta
  - e2e
INPUTS:
  - PlanPath
REQUIRED:
  - PlanPath
OUTPUTS:
  - ReviewPath
---

# End-to-End Test Review

Review the plan and provide structured feedback.


## 1. Read the output schema
- ARTIFACTS
  - ReviewSchemaPath "schemas/review.schema.json"
- PASS CONTINUE
- FAIL STOP

The schema defines the expected feedback output structure.


## 2. Read and review the plan
- ARTIFACTS
  - PlanPath
- PASS CONTINUE
- FAIL STOP

Checklist:
- Plan contains one task
- File: `end-to-end-test.md`
- Content: `This is the end-to-end test`


## 3. Write review
- ARTIFACTS
  - PlanPath
  - ReviewSchemaPath
  - ReviewPath "end-to-end-test-review.json"
- PASS CONTINUE
- FAIL STOP

Write a JSON review to `{{ path ReviewPath }}`.
Follow the output schema from `{{ path ReviewSchemaPath }}`.


## 4. Check Schema
- PASS COMPLETE
- FAIL GOTO 3

```bash
rdx {{ path ReviewPath }} --validate --schema review
```
