---
name: end-to-end-test-write-plan
description: Write one simple plan artifact for the end-to-end workflow.
tags:
  - meta
  - e2e
OUTPUTS:
  - PlanPath
---

# End-to-End Test Write Plan

Write one small plan file for the end-to-end workflow.


## 1. Read the plan schema
- ARTIFACTS
  - PlanSchemaPath "schemas/plan.schema.json"
- PASS CONTINUE
- FAIL STOP

Read the plan schema.
The schema defines the expected output structure for the plan.


## 2. Write plan
- ARTIFACTS
  - PlanSchemaPath
  - PlanPath "end-to-end-test-plan.json"
- PASS CONTINUE
- FAIL STOP

Write a JSON implementation plan to `{{ path PlanPath }}`.
Follow the plan output schema from `{{ path PlanSchemaPath }}`.

The plan should contain one task.
Task should write a file with the specified content.

- File: `end-to-end-test.md`
- Content: `This is the end-to-end test`


## 3. Check Schema
- PASS COMPLETE
- FAIL GOTO 2

```bash
rdx {{ path PlanPath }} --validate --schema plan
```
