---
name: review-plan-structural-integrity
description: Validate step ordering, dependencies, scope, and completeness of a plan
tags:
  - planning
  - review
---

# Review Structural Integrity

Validate the plan's structure, ordering, and completeness.

## 1. Find plan
- PASS CONTINUE
- FAIL STOP

Read the plan at `{{ PlanPath }}`.

## 2. Read the output schema
- PASS CONTINUE
- FAIL STOP

```prompt
{{ CLAUDE_PLUGIN_ROOT }}/schemas/review.schema.json
```


## 3. Is the plan structurally sound?
- PASS CONTINUE
- FAIL CONTINUE

- Steps are ordered so that each step's prerequisites are met by prior steps
- Step dependencies form a DAG with no circular references
- Each step has clear, testable completion criteria
- No step is too large (should be split) or too small (should be merged)
- Risky steps include error handling or fallback strategies
- Destructive or hard-to-reverse operations have a rollback strategy
- No gaps where intermediate steps are needed but missing
- Steps that make changes are followed by verification steps
- Success criteria, when all met, would achieve the stated goal
- Critical steps identify what could go wrong and how the failure would manifest
- Explicitly deferred work or known limitations are documented and tracked


## 4. Output Path
- ARTIFACTS
  - ReviewPath "review-plan-structural-integrity.json"
- OUTPUTS
  - ReviewPath
- PASS CONTINUE
- FAIL STOP

{{ ReviewPath }}


## 5. Write the review
- PASS CONTINUE
- FAIL STOP

Write the review to the output path as JSON.
Follow the review output schema.
Ensure any validation issues have been resolved.


## 6. Check Schema
- PASS COMPLETE
- FAIL GOTO 5

```bash
rdx --check {{ ReviewPath }}
```
