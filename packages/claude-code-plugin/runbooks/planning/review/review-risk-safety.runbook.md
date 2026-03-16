---
name: review-risk-safety
description: Assess security, performance, breaking changes, and safety concerns in a plan
tags:
  - planning
  - review
vars:
  PlanPath: ""
---

# Review Risk and Safety

Assess risk, security, and safety concerns in the plan.

## 1. Risk and safety checks

- PASS ALL CONTINUE
- FAIL ANY CONTINUE

### 1.1 Security implications assessed

- DEFER

Read the plan at `{{ PlanPath }}` and check for security concerns: input validation, authentication, authorization, data exposure, and injection risks.

### 1.2 Performance impact considered

- DEFER

Verify that performance-sensitive changes include benchmarks or impact analysis. Check for potential regressions in hot paths.

### 1.3 Breaking changes identified

- DEFER

Check that all breaking changes to public APIs, data formats, or behavior are explicitly identified.

### 1.4 Migration path for breaking changes

- DEFER

Verify that identified breaking changes include a migration path or deprecation strategy.

### 1.5 Data integrity protected

- DEFER

Check that operations involving persistent data (files, databases, state) protect against corruption and data loss.

### 1.6 Concurrent operation safety

- DEFER

Verify that concurrent or parallel operations are safe from race conditions and resource conflicts.

### 1.7 Error recovery procedures

- DEFER

Check that failure scenarios have documented recovery procedures beyond "retry."

### 1.8 Monitoring and observability

- DEFER

Verify that changes include appropriate logging, metrics, or monitoring where the plan touches observable behavior.

## 2. Write findings

Write the results of each check above to the path resolved by `rdpath --dir {{ WorkPath }} --ctx {{ ContextId }} --file risk-safety-pass{{ context.parent.index }}.md`. List each check with PASS/FAIL, provide evidence for each FAIL, and include an overall assessment. First ensure the output directory exists:

```bash
mkdir -p "$(rdpath --dir {{ WorkPath }} --ctx {{ ContextId }})"
```
