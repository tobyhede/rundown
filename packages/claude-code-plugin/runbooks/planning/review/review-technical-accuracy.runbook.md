---
name: review-technical-accuracy
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

```bash
rdpath --dir {{ WorkPath }} --ctx {{ ContextId }} find "*plan.json"
```

## 2. Read the output schema
- PASS CONTINUE
- FAIL STOP

```prompt
{{ CLAUDE_PLUGIN_ROOT }}/schemas/review.schema.json
```

## 3. Review the plan for technical accuracy
- PASS COMPLETE
- FAIL CONTINUE

- File paths referenced in the plan exist in the codebase (source and test files)
- Classes, functions, types, and symbols exist at the locations claimed
- Import and module paths are valid and resolve correctly
- Shell commands are syntactically valid and required tools are available
- Proposed changes follow the project's established patterns and conventions


## 4. Write the review
- PASS COMPLETE
- FAIL STOP

Write the review to the output path as JSON.
Follow the review output schema.

```bash
rdpath --dir {{ WorkPath }} --ctx {{ ContextId }} --file plan-review-{{ RunId }}.json
```
