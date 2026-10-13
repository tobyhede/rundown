---
name: execute-plan-harness
description: Scenario harness — produce a PlanPath artifact, then compose execute-plan inline on the same Owner Token.
OUTPUTS:
  - PlanPath
---

# Execute Plan Harness

execute-plan requires a `PlanPath` artifact, which a top-level `rundown run`
cannot supply from a plain path. In production a planning run's write-plan
Delegation produces it; here step 1 does.

## 1. Produce the plan
- ARTIFACTS
  - PlanPath "plan.json"
- PASS CONTINUE
- FAIL STOP

Write the plan to `{{ path PlanPath }}`.

## 2. Execute the plan
- PASS ALL COMPLETE
- FAIL ANY STOP

- planning/execute-plan.runbook.md
