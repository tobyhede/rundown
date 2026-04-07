---
name: review-structural-integrity
description: Validate step ordering, dependencies, scope, and completeness of a plan
tags:
  - planning
  - review
---

# Review Structural Integrity

Validate the plan's structure, ordering, and completeness.

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

## 4. Structural checks

- PASS ALL CONTINUE
- FAIL ANY CONTINUE

### 4.1 Step ordering logical

- DEFER

Read the plan found in step 1 and verify steps are ordered so that each step's prerequisites are met by prior steps.

### 4.2 No circular dependencies

- DEFER

Check that step dependencies form a DAG with no circular references.

### 4.3 Clear completion criteria

- DEFER

Verify each step has clear, testable criteria for when it is done.

### 4.4 Appropriate step scope

- DEFER

Check that no step is too large (should be split) or too small (should be merged). Each step should represent a single coherent unit of work.

### 4.5 Error handling defined

- DEFER

Verify that risky steps include error handling or fallback strategies.

### 4.6 Rollback strategy present

- DEFER

Check that destructive or hard-to-reverse operations have a rollback strategy documented.

### 4.7 No missing intermediate steps

- DEFER

Look for gaps where an intermediate step is needed but missing (e.g., build before test, create before configure).

### 4.8 Verification steps present

- DEFER

Verify that steps which make changes are followed by verification steps (tests, checks, or manual confirmation).

### 4.9 Success criteria map to goals

- DEFER

Check that the plan's stated success criteria, when all met, would achieve the stated goal.

### 4.10 Failure modes identified

- DEFER

Verify that critical steps identify what could go wrong and how the failure would manifest.

### 4.11 Deferred items tracked

- DEFER

Check that any explicitly deferred work or known limitations are documented and tracked.

## 5. Write findings
- PASS COMPLETE
- FAIL STOP

Write findings as JSON to the output path (step 3), conforming to the review schema (step 2). Set `status` to `"ok"` if no blocking issues, `"blocked"` otherwise. Each finding needs: title, severity, description, evidence, recommendation.
