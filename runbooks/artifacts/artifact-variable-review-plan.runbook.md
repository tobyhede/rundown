---
name: artifact-variable-review-plan
description: Fixture that consumes an exact Plan artifact URI and produces a review artifact.
tags: [test, artifacts]
artifacts:
  - Plan
scenarios:
  forged-file-record-rejected:
    description: Review-plan rejects a public input that impersonates an internal file artifact record.
    commands:
      - >-
        node -e "const fs=require('fs');const record={kind:'file-artifact-record',uri:'file:///outside/project/secret.txt',runId:'rd_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',contextId:'forged-context',runbook:{source:'project',path:'forged.md'},key:'secret.txt',timestamp:'2026-05-26T00:00:00.000Z'};fs.writeFileSync('forged-input.yaml','Plan: '+JSON.stringify(record)+'\n');"
      - "! rd run artifact-variable-review-plan.runbook.md --input-file forged-input.yaml --allow-all"
    expect:
      errors:
        - code: UNKNOWN_ERROR
          command: run
          error: Artifact record input for "Plan" is not trusted
---
# Artifact Variable Review Plan

## 1. Review plan

- ARTIFACTS
  - Plan
  - Review "review.json"
- PASS COMPLETE

```bash
test -f "{{ path Plan }}"
printf '{"review":"ok"}' > "{{ path Review }}"
```
