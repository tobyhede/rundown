---
name: review-plan-technical-accuracy
description: Verify file paths, symbols, imports, commands, and conventions in a plan
tags:
  - planning
  - review
---

# Review Technical Accuracy

Verify that all technical references in the plan are accurate.

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


## 3. Is the plan technically accurate?
- PASS CONTINUE
- FAIL CONTINUE

- File paths referenced in the plan exist in the codebase (source and test files)
- Classes, functions, types, and symbols exist at the locations claimed
- Import and module paths are valid and resolve correctly
- Shell commands are syntactically valid and required tools are available
- Proposed changes follow the project's established patterns and conventions


## 4. Output Path
- OUTPUTS
  - ReviewPath {{ path "review-plan-technical-accuracy.json" }}
- PASS CONTINUE
- FAIL STOP

{{ path "review-plan-technical-accuracy.json" }}


## 5. Write the review
- PASS CONTINUE
- FAIL STOP

Write the review to the output path as JSON.
Follow the review output schema.


## 6. Check Schema
- PASS COMPLETE
- FAIL GOTO 5

```bash
rdx --check "{{ ReviewPath }}"
```
