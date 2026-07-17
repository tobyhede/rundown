---
name: scenario-seed-artifacts
description: Deterministic producer fixture that seeds artifacts through the real ARTIFACTS production path.
tags: [test, artifacts]
scenarios:
  seeds-two-artifacts:
    description: Seeder produces both seed artifact keys with backing files.
    commands:
      - rd run scenario-seed-artifacts.runbook.md --allow-all
    expect:
      result: COMPLETE
      artifacts:
        - at: "1"
          alias: PlanPathSeed
          key: PlanPath
          runbook: scenario-seed-artifacts.runbook.md
          exists: true
        - at: "1"
          alias: PlanJsonSeed
          key: plan.json
          runbook: scenario-seed-artifacts.runbook.md
          exists: true
---
# Scenario Seed Artifacts

Producer fixture for scenarios that need a pre-existing artifact. Consumers run
this first and reference the produced artifact with
`${CAPTURE_ARTIFACT:<key>}` — never by fabricating an `rd://` URI.

## 1. Seed artifacts

- ARTIFACTS
  - PlanPathSeed "PlanPath"
  - PlanJsonSeed "plan.json"
- PASS COMPLETE

```bash
printf '{"seeded":true}' > "{{ path PlanPathSeed }}"
printf '{"seeded":true}' > "{{ path PlanJsonSeed }}"
```
