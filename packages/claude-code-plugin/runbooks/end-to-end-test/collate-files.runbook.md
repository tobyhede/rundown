---
name: end-to-end-test-collate
description: Read end-to-end workflow artifacts and write one collated review artifact.
tags:
  - meta
  - e2e
inputs:
  - PlanPath
required:
  - PlanPath
outputs:
  - CollatedPath
---

# End-to-End Test Collate

Read the plan and review artifacts, then write one collated review artifact.

## 1. Read the output schema
- ARTIFACTS
  - ReviewSchemaPath "review.schema.json"
- PASS CONTINUE
- FAIL STOP

Read the review output schema artifact for collation.

```prompt
{{ path ReviewSchemaPath }}
```


## 2. Read artifacts
- ARTIFACTS
  - PlanPath
  - ReviewPaths "end-to-end-test-review-*.json"
- PASS CONTINUE
- FAIL STOP

Read these files:

- Plan: `{{ path PlanPath }}`
- Reviews: `{{ path ReviewPaths }}`


## 3. Output path
- ARTIFACTS
  - CollatedPath "end-to-end-test-collated-review.json"
- OUTPUTS
  - CollatedPath
- PASS CONTINUE
- FAIL STOP

{{ path CollatedPath }}


## 4. Write collated review
- ARTIFACTS
  - PlanPath
  - ReviewSchemaPath
  - ReviewPaths
  - CollatedPath
- PASS CONTINUE
- FAIL STOP

Write the collated review to `{{ path CollatedPath }}` as JSON.
Follow the review output schema from `{{ path ReviewSchemaPath }}`.

Read every review artifact in `{{ path ReviewPaths }}`.
Merge findings into one canonical review document and deduplicate equivalent findings.

The collated review should:

- Include `$schema: "https://rundown.org/schemas/review.schema.json"`
- Include `meta.version: "1.0.0"`
- Include an empty `items` array when there are no review findings
- Include findings only for concrete issues identified by the delegated reviews


## 5. Check Schema
- ARTIFACTS
  - CollatedPath
- PASS COMPLETE
- FAIL GOTO 4

```bash
rdx --check {{ path CollatedPath }}
```
