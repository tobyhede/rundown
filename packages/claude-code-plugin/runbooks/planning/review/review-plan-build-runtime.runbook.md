---
name: review-plan-build-runtime
description: Verify build commands, test commands, dependencies, and environment in a plan
tags:
  - planning
  - review

---

# Review Build and Runtime

Verify that build, test, and runtime concerns are addressed.

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


## 3. Are build and runtime concerns addressed?
- PASS CONTINUE
- FAIL CONTINUE

- Build commands are correct for the project's build system and would produce expected outputs
- Test commands reference the correct test framework, use proper flags, and target the right files
- All dependencies (packages, tools, services) are available and version-compatible
- Environment requirements (Node version, env vars, config files, credentials) are documented
- Changes won't break CI/CD pipelines and any pipeline modifications are included


## 4. Output Path
- ARTIFACTS
  - ReviewPath "review-plan-build-runtime.json"
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
{{ validateSchema ReviewPath }}
```
