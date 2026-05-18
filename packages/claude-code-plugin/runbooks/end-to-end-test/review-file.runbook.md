---
name: end-to-end-test-review
description: Read the plan artifact and write one review artifact.
tags:
  - meta
  - e2e
inputs:
  - PlanPath
required:
  - PlanPath
outputs:
  - ReviewPath
---

# End-to-End Test Review

Read the plan artifact and write one small review artifact.

## 1. Read the output schema
- ARTIFACTS
  - ReviewSchemaPath "review.schema.json"
- PASS CONTINUE
- FAIL STOP

Read the review output schema artifact for this review.

```prompt
{{ path ReviewSchemaPath }}
```


## 2. Read plan
- ARTIFACTS
  - PlanPath
- PASS CONTINUE
- FAIL STOP

Read the plan file at `{{ path PlanPath }}`.


## 3. Output path
- ARTIFACTS
  - ReviewPath "end-to-end-test-review-{{ RunId }}.json"
- OUTPUTS
  - ReviewPath
- PASS CONTINUE
- FAIL STOP

{{ path ReviewPath }}


## 4. Write review
- ARTIFACTS
  - PlanPath
  - ReviewSchemaPath
  - ReviewPath
- PASS CONTINUE
- FAIL STOP

Write a short JSON review to `{{ path ReviewPath }}`.
Follow the review output schema from `{{ path ReviewSchemaPath }}`.

The review should:

- Include `$schema: "https://rundown.org/schemas/review.schema.json"`
- Include `meta.version: "1.0.0"`
- Include an empty `items` array when there are no issues
- Add findings only for concrete issues in the plan at `{{ path PlanPath }}`
- Check that the plan contains a single trivial task with clear files, subtasks, and verification guidance


## 5. Check Schema
- ARTIFACTS
  - ReviewPath
- PASS COMPLETE
- FAIL GOTO 4

```bash
rdx --check {{ path ReviewPath }}
```
