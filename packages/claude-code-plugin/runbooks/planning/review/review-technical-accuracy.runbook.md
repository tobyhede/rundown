---
name: review-technical-accuracy
description: Verify file paths, symbols, imports, commands, and conventions in a plan
tags:
  - planning
  - review
---

# Review Technical Accuracy

Verify that all technical references in the plan are accurate.

## 1. Resolve plan path
- PASS CONTINUE
- FAIL STOP

```bash
rdpath --dir {{ WorkPath }} --ctx {{ ContextId }} find "*plan.json"
```

## 2. Review output schema
- PASS CONTINUE
- FAIL STOP

Schema: `{{ CLAUDE_PLUGIN_ROOT }}/schemas/review.schema.json`

## 3. Output path
- PASS CONTINUE
- FAIL STOP

```bash
mkdir -p "$(rdpath --dir {{ WorkPath }} --ctx {{ ContextId }})"
rdpath --dir {{ WorkPath }} --ctx {{ ContextId }} --file plan-review-{{ RunId }}.json
```

## 4. Technical checks

- PASS ALL CONTINUE
- FAIL ANY CONTINUE

### 4.1 File paths exist

Read the plan found in step 1 and verify every file path referenced in the plan exists in the codebase. Check both source and test files.

### 4.2 Symbols exist

- DEFER

Verify that classes, functions, types, and other symbols referenced in the plan exist at the locations claimed. Use codebase search to confirm.

### 4.3 Import paths resolve

- DEFER

Check that import and module paths mentioned in the plan are valid and would resolve correctly given the project's module system.

### 4.4 Shell commands valid

- DEFER

Verify shell commands in the plan are syntactically valid and that required tools are available in the project environment.

### 4.5 Project patterns followed

- DEFER

Check that proposed code changes follow the project's established patterns and conventions (naming, structure, error handling).

## 5. Write findings
- PASS COMPLETE
- FAIL STOP

Write findings as JSON to the output path (step 3), conforming to the review schema (step 2). Set `status` to `"ok"` if no blocking issues, `"blocked"` otherwise. Each finding needs: title, severity, description, evidence, recommendation.
