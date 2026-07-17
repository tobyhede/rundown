---
name: artifact-variable-collate
description: Fixture that consumes a URI-array review artifact input.
tags: [test, artifacts]
artifacts:
  - Reviews
scenarios:
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
# Artifact Variable Collate

## 1. Collate reviews

- ARTIFACTS
  - Reviews
- PASS COMPLETE

```bash
rd echo --result pass
```
