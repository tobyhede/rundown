---
name: end-to-end-test-write-plan
description: Write one simple plan artifact for the end-to-end workflow.
tags:
  - meta
  - e2e
outputs:
  - PlanPath
---

# End-to-End Test Write Plan

Write one small plan file for the end-to-end workflow.

## 1. Read the plan schema
- ARTIFACTS
  - PlanSchemaPath "plan.schema.json"
- PASS CONTINUE
- FAIL STOP

Read the plan schema artifact for this write step.

```prompt
{{ path PlanSchemaPath }}
```


## 2. Output path
- ARTIFACTS
  - PlanPath "end-to-end-test-plan.json"
- OUTPUTS
  - PlanPath
- PASS CONTINUE
- FAIL STOP

{{ path PlanPath }}


## 3. Write plan
- ARTIFACTS
  - PlanSchemaPath
  - PlanPath
- PASS CONTINUE
- FAIL STOP

Write a compact JSON implementation plan to `{{ path PlanPath }}`.
Follow the plan output schema from `{{ path PlanSchemaPath }}`.

The plan must contain exactly one trivial implementation task:

- Create `end-to-end-test-output.txt`
- Write one sentence identifying the file as the end-to-end test output
- Verify the file exists and contains that sentence


## 4. Check Schema
- ARTIFACTS
  - PlanPath
- PASS COMPLETE
- FAIL GOTO 3

```bash
rdx --check {{ path PlanPath }}
```
