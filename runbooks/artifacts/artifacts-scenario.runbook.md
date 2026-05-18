---
name: artifacts-scenario
scenarios:
  global-artifact-variable:
    description: ARTIFACTS populate global variables across later steps
    commands:
      - rd run artifacts-scenario.runbook.md --allow-all
    expect:
      result: COMPLETE
      artifacts:
        - at: "1"
          alias: PlanPath
          key: plan.json
          runbook: artifacts-scenario.runbook.md
          exists: true
---
# Artifacts Scenario

## 1. Produce

- ARTIFACTS
  - PlanPath "plan.json"
- PASS CONTINUE

```bash
printf '{"plan":"ok"}' > "{{ path PlanPath }}"
```

## 2. Consume

- ARTIFACTS
  - PlanPath
- PASS CONTINUE

```bash
test -f "{{ path PlanPath }}"
```

## 3. Finish

- PASS COMPLETE

```bash
rd echo --result pass
```
