---
name: review-risk-safety
description: Assess security, performance, breaking changes, and safety concerns in a plan
tags:
  - planning
  - review
---

# Review Risk and Safety

Assess risk, security, and safety concerns in the plan.

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

## 4. Risk and safety checks

- PASS ALL CONTINUE
- FAIL ANY CONTINUE

### 4.1 Security implications assessed

- DEFER

Read the plan found in step 1 and check for security concerns: input validation, authentication, authorization, data exposure, and injection risks.

### 4.2 Performance impact considered

- DEFER

Verify that performance-sensitive changes include benchmarks or impact analysis. Check for potential regressions in hot paths.

### 4.3 Breaking changes identified

- DEFER

Check that all breaking changes to public APIs, data formats, or behavior are explicitly identified.

### 4.4 Migration path for breaking changes

- DEFER

Verify that identified breaking changes include a migration path or deprecation strategy.

### 4.5 Data integrity protected

- DEFER

Check that operations involving persistent data (files, databases, state) protect against corruption and data loss.

### 4.6 Concurrent operation safety

- DEFER

Verify that concurrent or parallel operations are safe from race conditions and resource conflicts.

### 4.7 Error recovery procedures

- DEFER

Check that failure scenarios have documented recovery procedures beyond "retry."

### 4.8 Monitoring and observability

- DEFER

Verify that changes include appropriate logging, metrics, or monitoring where the plan touches observable behavior.

## 5. Write findings
- PASS COMPLETE
- FAIL STOP

Write findings as JSON to the output path (step 3), conforming to the review schema (step 2). Set `status` to `"ok"` if no blocking issues, `"blocked"` otherwise. Each finding needs: title, severity, description, evidence, recommendation.
