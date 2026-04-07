---
name: review-build-runtime
description: Verify build commands, test commands, dependencies, and environment in a plan
tags:
  - planning
  - review
---

# Review Build and Runtime

Verify that build, test, and runtime concerns are addressed.

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

## 4. Build and runtime checks

- PASS ALL CONTINUE
- FAIL ANY CONTINUE

### 4.1 Build commands correct

- DEFER

Read the plan found in step 1 and verify that build commands are correct for the project's build system and would produce the expected outputs.

### 4.2 Test commands correct

- DEFER

Check that test commands reference the correct test framework, use proper flags, and target the right test files or suites.

### 4.3 Dependencies available

- DEFER

Verify that all dependencies (packages, tools, services) referenced in the plan are available and version-compatible.

### 4.4 Environment requirements documented

- DEFER

Check that environment requirements (Node version, env vars, config files, credentials) are documented where needed.

### 4.5 CI/CD integration considered

- DEFER

Verify that changes won't break CI/CD pipelines and that any pipeline modifications are included in the plan.

## 5. Write findings
- PASS COMPLETE
- FAIL STOP

Write findings as JSON to the output path (step 3), conforming to the review schema (step 2). Set `status` to `"ok"` if no blocking issues, `"blocked"` otherwise. Each finding needs: title, severity, description, evidence, recommendation.
