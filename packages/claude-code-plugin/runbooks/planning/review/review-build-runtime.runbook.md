---
name: review-build-runtime
description: Verify build commands, test commands, dependencies, and environment in a plan
tags:
  - planning
  - review
vars:
  PlanPath: ""
---

# Review Build and Runtime

Verify that build, test, and runtime concerns are addressed.

## 1. Build and runtime checks

- PASS ALL CONTINUE
- FAIL ANY CONTINUE

### 1.1 Build commands correct

- DEFER

Read the plan at `{{ PlanPath }}` and verify that build commands are correct for the project's build system and would produce the expected outputs.

### 1.2 Test commands correct

- DEFER

Check that test commands reference the correct test framework, use proper flags, and target the right test files or suites.

### 1.3 Dependencies available

- DEFER

Verify that all dependencies (packages, tools, services) referenced in the plan are available and version-compatible.

### 1.4 Environment requirements documented

- DEFER

Check that environment requirements (Node version, env vars, config files, credentials) are documented where needed.

### 1.5 CI/CD integration considered

- DEFER

Verify that changes won't break CI/CD pipelines and that any pipeline modifications are included in the plan.

## 2. Write findings

Write the results of each check above to the path resolved by `rdpath --dir {{ WorkPath }} --ctx {{ ContextId }} --file build-runtime-pass{{ context.parent.index }}.md`. List each check with PASS/FAIL, provide evidence for each FAIL, and include an overall assessment. First ensure the output directory exists:

```bash
mkdir -p "$(rdpath --dir {{ WorkPath }} --ctx {{ ContextId }})"
```
