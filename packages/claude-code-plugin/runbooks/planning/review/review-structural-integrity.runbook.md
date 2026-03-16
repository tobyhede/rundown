---
name: review-structural-integrity
description: Validate step ordering, dependencies, scope, and completeness of a plan
tags:
  - planning
  - review
vars:
  PlanPath: ""
---

# Review Structural Integrity

Validate the plan's structure, ordering, and completeness.

## 1. Structural checks

- PASS ALL CONTINUE
- FAIL ANY CONTINUE

### 1.1 Step ordering logical

- DEFER

Read the plan at `{{ PlanPath }}` and verify steps are ordered so that each step's prerequisites are met by prior steps.

### 1.2 No circular dependencies

- DEFER

Check that step dependencies form a DAG with no circular references.

### 1.3 Clear completion criteria

- DEFER

Verify each step has clear, testable criteria for when it is done.

### 1.4 Appropriate step scope

- DEFER

Check that no step is too large (should be split) or too small (should be merged). Each step should represent a single coherent unit of work.

### 1.5 Error handling defined

- DEFER

Verify that risky steps include error handling or fallback strategies.

### 1.6 Rollback strategy present

- DEFER

Check that destructive or hard-to-reverse operations have a rollback strategy documented.

### 1.7 No missing intermediate steps

- DEFER

Look for gaps where an intermediate step is needed but missing (e.g., build before test, create before configure).

### 1.8 Verification steps present

- DEFER

Verify that steps which make changes are followed by verification steps (tests, checks, or manual confirmation).

### 1.9 Success criteria map to goals

- DEFER

Check that the plan's stated success criteria, when all met, would achieve the stated goal.

### 1.10 Failure modes identified

- DEFER

Verify that critical steps identify what could go wrong and how the failure would manifest.

### 1.11 Deferred items tracked

- DEFER

Check that any explicitly deferred work or known limitations are documented and tracked.

## 2. Write findings

Write the results of each check above to the path resolved by `rdpath --dir {{ WorkPath }} --ctx {{ ContextId }} --file structural-integrity-pass{{ context.parent.index }}.md`. List each check with PASS/FAIL, provide evidence for each FAIL, and include an overall assessment. First ensure the output directory exists:

```bash
mkdir -p "$(rdpath --dir {{ WorkPath }} --ctx {{ ContextId }})"
```
