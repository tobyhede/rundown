---
name: review-plan-risk-safety
description: Assess security, performance, breaking changes, and safety concerns in a plan
tags:
  - planning
  - review
---

# Review Risk and Safety

Assess risk, security, and safety concerns in the plan.

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


## 3. Is the plan safe and risk-free?
- PASS CONTINUE
- FAIL CONTINUE

- Security concerns are assessed: input validation, authentication, authorization, data exposure, injection risks
- Performance-sensitive changes include benchmarks or impact analysis
- All breaking changes to public APIs, data formats, or behavior are explicitly identified
- Breaking changes include a migration path or deprecation strategy
- Operations involving persistent data protect against corruption and data loss
- Concurrent or parallel operations are safe from race conditions and resource conflicts
- Failure scenarios have documented recovery procedures beyond "retry"
- Changes include appropriate logging, metrics, or monitoring where observable behavior is touched


## 4. Output Path
- ARTIFACTS
  - ReviewPath "review-plan-risk-safety.json"
- OUTPUTS
  - ReviewPath
- PASS CONTINUE
- FAIL STOP

{{ path "review-plan-risk-safety.json" }}


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
