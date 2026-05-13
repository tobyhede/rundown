---
name: artifacts-resolution-failure
scenarios:
  resolver-failure-stops:
    description: ARTIFACTS resolution failure stops the runbook
    commands:
      - "! rd run --prompted artifacts-resolution-failure.runbook.md"
    result: STOP
---
# Artifacts Resolution Failure

## 1. Unbound naked declaration
- ARTIFACTS
  - MissingPath
- PASS COMPLETE
