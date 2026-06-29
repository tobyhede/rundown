---
name: execute-plan
artifacts:
  - PlanPath
required:
  - PlanPath
scenarios:
  consume-plan-artifact:
    description: a boundary --artifacts value is consumed by a naked ARTIFACTS step
    seed:
      - artifact: PlanPath
    commands:
      - "rd run execute-plan.runbook.md --artifacts PlanPath=${ARTIFACT:PlanPath}"
    expect:
      result: COMPLETE
      artifacts:
        - at: "1"
          alias: PlanPath
          key: PlanPath
          exists: true
---
# Execute Plan

## 1. Read the plan

- ARTIFACTS
  - PlanPath
- PASS COMPLETE

```bash
rd echo --result pass plan="{{ path PlanPath }}"
```
