---
name: artifact-status-vars
description: Status vars include artifact-record variables
tags: [test, artifacts]
scenarios:
  status-shows-artifact-vars:
    description: rd status surfaces ARTIFACTS variables as URI strings
    commands:
      - rd run artifact-status-vars.runbook.md --allow-all
      - >-
        node -e 'const { execFileSync } = require("node:child_process"); const status = JSON.parse(execFileSync("rd", ["status"], { encoding: "utf8" })); const value = status.vars && status.vars.PlanPath; if (typeof value !== "string" || !value.startsWith("rd://artifacts/") || !value.endsWith("/plan.json")) { console.error(JSON.stringify(status.vars)); process.exit(1); }'
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

The active status output should include `PlanPath`.
