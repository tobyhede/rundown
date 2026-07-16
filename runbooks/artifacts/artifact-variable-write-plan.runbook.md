---
name: artifact-variable-write-plan
description: Fixture for artifact variable handoff scenarios.
tags: [test, artifacts]
scenarios:
  write-plan-produces-artifact:
    description: Write-plan completes and records the produced plan artifact.
    commands:
      - rd run artifact-variable-write-plan.runbook.md --allow-all
    expect:
      result: COMPLETE
      artifacts:
        - at: "1"
          alias: Plan
          key: plan.json
          runbook: artifact-variable-write-plan.runbook.md
          exists: true

  review-plan-uri-input:
    description: Review-plan receives an exact rd:// Plan input and treats it as an artifact.
    commands:
      - rd run artifact-variable-write-plan.runbook.md --allow-all
      - rd run artifact-variable-review-plan.runbook.md --artifacts Plan=${CAPTURE_ARTIFACT:plan.json} --allow-all
    expect:
      result: COMPLETE
      artifacts:
        - at: "1"
          alias: Plan
          key: plan.json
          runbook: artifact-variable-review-plan.runbook.md
          exists: true

  bundled-write-review-collate-artifacts:
    description: Write, review, and collate pass artifacts across runbook boundaries without RD-816.
    commands:
      - rd run artifact-variable-write-plan.runbook.md --allow-all
      - rd run artifact-variable-review-plan.runbook.md --artifacts Plan=${CAPTURE_ARTIFACT:plan.json} --allow-all
      - rd run artifact-variable-collate.runbook.md --artifacts-json 'Reviews=${CAPTURE_ARTIFACT_ARRAY:review.json}' --allow-all
    expect:
      result: COMPLETE
      artifacts:
        - at: "1"
          alias: Reviews
          key: review.json
          count: 1
          runbook: artifact-variable-collate.runbook.md
          exists: true
---
# Artifact Variable Write Plan

## 1. Write plan

- ARTIFACTS
  - Plan "plan.json"
- PASS COMPLETE

```bash
printf '{"plan":"ok"}' > "{{ path Plan }}"
```
