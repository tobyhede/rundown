---
name: artifact-status-vars
description: Status vars include artifact-record variables
tags: [test, artifacts]
scenarios:
  artifact-var-in-scope-completes:
    description: A produced artifact variable stays in scope across steps and the runbook completes.
    commands:
      - rd run artifact-status-vars.runbook.md --allow-all
      - rd complete
    expect:
      result: COMPLETE
---
# Status vars include artifact variables

## 1. Produce an artifact variable

- ARTIFACTS
  - PlanPath "plan.json"
- PASS CONTINUE

```bash
printf '{"plan":"ok"}' > "{{ path PlanPath }}"
```

## 2. Pause with the artifact variable in scope

- ARTIFACTS
  - PlanPath
- PASS COMPLETE
- FAIL STOP

The active status output should include `PlanPath`, rendered as a local path
rather than an `rd://` URI. That payload assertion lives in
`packages/cli/__tests__/integration/artifact-variable-inputs.test.ts` — scenario
`commands:` assert through the scenario schema, never by inspecting CLI output
in a shell wrapper.
