---
name: review-technical-accuracy
description: Verify file paths, symbols, imports, commands, and conventions in a plan
tags:
  - planning
  - review
vars:
  PlanPath: .work/plan.md
---

# Review Technical Accuracy

Verify that all technical references in the plan are accurate.

## 1. Technical checks

- FAIL ANY: STOP "Technical accuracy issues found."

### 1.1 File paths exist

- DEFER

Read the plan at `{{ PlanPath }}` and verify every file path referenced in the plan exists in the codebase. Check both source and test files.

### 1.2 Symbols exist

- DEFER

Verify that classes, functions, types, and other symbols referenced in the plan exist at the locations claimed. Use codebase search to confirm.

### 1.3 Import paths resolve

- DEFER

Check that import and module paths mentioned in the plan are valid and would resolve correctly given the project's module system.

### 1.4 Shell commands valid

- DEFER

Verify shell commands in the plan are syntactically valid and that required tools are available in the project environment.

### 1.5 Project patterns followed

- DEFER

Check that proposed code changes follow the project's established patterns and conventions (naming, structure, error handling).

## 2. Write findings

Write the results of each check above to `{{ WorkPath }}/reviews/technical-accuracy-pass{{ context.parent.index }}.md`. List each check with PASS/FAIL, provide evidence for each FAIL, and include an overall assessment.
