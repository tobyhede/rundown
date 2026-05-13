---
name: artifacts-scenario
scenarios:
  global-artifact-variable:
    description: ARTIFACTS populate global variables across later steps
    commands:
      - rd run --prompted artifacts-scenario.runbook.md
      - rd pass
      - rd pass
      - rd pass
    result: COMPLETE
---
# Artifacts Scenario

## 1. Produce

- ARTIFACTS
  - PlanPath "plan.json"
- PASS CONTINUE

## 2. Consume

- ARTIFACTS
  - PlanPath
- PASS CONTINUE

## 3. Finish

- PASS COMPLETE
